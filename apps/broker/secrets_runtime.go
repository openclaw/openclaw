package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const secretMetadataCacheTTL = 60 * time.Second

var (
	secretNameRE      = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	secretReferenceRE = regexp.MustCompile(`\$(?:([A-Z][A-Z0-9_]*)|\{([A-Z][A-Z0-9_]*)\})`)
	allowedCategories = map[string]struct{}{
		"ssh_key": {},
		"api_key": {},
		"token":   {},
		"env_var": {},
	}
)

type platformSecretsClient interface {
	ListMetadata(ctx context.Context, tenantID string) ([]secretMetadata, error)
	CandidateMetadata(ctx context.Context, tenantID string, names []string) (map[string]string, error)
	Resolve(ctx context.Context, tenantID string, names []string, tool string) (resolvedSecretSet, error)
}

type secretMetadata struct {
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	Description *string `json:"description,omitempty"`
	CreatedAt   *string `json:"created_at,omitempty"`
	LastUsedAt  *string `json:"last_used_at,omitempty"`
}

type resolvedSecretSet struct {
	Values     map[string]string
	Categories map[string]string
	Missing    []string
}

type resolvedCommandSecrets struct {
	Values   map[string]string
	Redactor *secretRedactor
}

type httpPlatformSecretsClient struct {
	httpClient *http.Client
}

var brokerSecretsClient platformSecretsClient = httpPlatformSecretsClient{
	httpClient: &http.Client{Timeout: 10 * time.Second},
}

type metadataCacheEntry struct {
	category string
	known    bool
	expires  time.Time
}

var metadataCache = struct {
	sync.Mutex
	entries map[string]metadataCacheEntry
}{entries: map[string]metadataCacheEntry{}}

func extractSecretReferenceCandidates(command string) []string {
	matches := secretReferenceRE.FindAllStringSubmatch(command, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(matches))
	for _, match := range matches {
		name := match[1]
		if name == "" {
			name = match[2]
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func rejectDisallowedSecretReferences(ctx context.Context, command string) error {
	candidates := extractSecretReferenceCandidates(command)
	if len(candidates) == 0 {
		return nil
	}
	known, err := cachedCandidateMetadata(ctx, tenantID(), candidates)
	if err != nil {
		return err
	}
	if len(known) == 0 {
		return nil
	}
	return errors.New("stored secret resolution is only supported by materialize_secret")
}

func validateResolvedExactSet(requested []string, resolved resolvedSecretSet, metadata map[string]string) error {
	seenRequested := map[string]struct{}{}
	for _, name := range requested {
		if !secretNameRE.MatchString(name) {
			return fmt.Errorf("invalid requested secret name %q", name)
		}
		if _, ok := seenRequested[name]; ok {
			return fmt.Errorf("duplicate requested secret name %q", name)
		}
		seenRequested[name] = struct{}{}
	}
	resolvedNames := map[string]struct{}{}
	for name, value := range resolved.Values {
		if _, ok := seenRequested[name]; !ok {
			return fmt.Errorf("resolve returned unrequested secret %q", name)
		}
		if value == "" {
			return fmt.Errorf("resolve returned empty value for %q", name)
		}
		resolvedNames[name] = struct{}{}
		category, ok := resolved.Categories[name]
		if !ok {
			return fmt.Errorf("resolve omitted category for %q", name)
		}
		if _, ok := allowedCategories[category]; !ok {
			return fmt.Errorf("resolve returned invalid category for %q", name)
		}
		if cachedCategory, ok := metadata[name]; ok && cachedCategory != category {
			return fmt.Errorf("resolve category mismatch for %q", name)
		}
	}
	missingNames := map[string]struct{}{}
	for _, name := range resolved.Missing {
		if _, ok := seenRequested[name]; !ok {
			return fmt.Errorf("resolve returned unrequested missing secret %q", name)
		}
		if _, ok := resolvedNames[name]; ok {
			return fmt.Errorf("resolve returned %q as both resolved and missing", name)
		}
		missingNames[name] = struct{}{}
	}
	for name := range seenRequested {
		_, isResolved := resolvedNames[name]
		_, isMissing := missingNames[name]
		if !isResolved && !isMissing {
			return fmt.Errorf("resolve omitted requested secret %q", name)
		}
		if isMissing {
			return fmt.Errorf("secret %q is missing", name)
		}
	}
	for name := range resolved.Categories {
		if _, ok := resolvedNames[name]; !ok {
			return fmt.Errorf("resolve returned category for unresolved secret %q", name)
		}
	}
	return nil
}

func assertNoSecretInArgv(argv []string, values map[string]string) error {
	for _, arg := range argv {
		for name, value := range values {
			if value == "" {
				continue
			}
			if strings.Contains(arg, value) {
				return fmt.Errorf("secret %q appeared in child argv", name)
			}
		}
	}
	return nil
}

func cachedCandidateMetadata(ctx context.Context, tenantID string, names []string) (map[string]string, error) {
	out := map[string]string{}
	if len(names) == 0 {
		return out, nil
	}
	now := time.Now()
	missing := []string{}
	metadataCache.Lock()
	for _, name := range names {
		key := tenantID + "\x00" + name
		if entry, ok := metadataCache.entries[key]; ok && now.Before(entry.expires) {
			if entry.known {
				out[name] = entry.category
			}
			continue
		}
		missing = append(missing, name)
	}
	metadataCache.Unlock()
	if len(missing) == 0 {
		return out, nil
	}
	fresh, err := brokerSecretsClient.CandidateMetadata(ctx, tenantID, missing)
	if err != nil {
		return nil, err
	}
	metadataCache.Lock()
	for _, name := range missing {
		category, known := fresh[name]
		metadataCache.entries[tenantID+"\x00"+name] = metadataCacheEntry{
			category: category,
			known:    known,
			expires:  now.Add(secretMetadataCacheTTL),
		}
		if known {
			out[name] = category
		}
	}
	metadataCache.Unlock()
	return out, nil
}

func (c httpPlatformSecretsClient) CandidateMetadata(ctx context.Context, tenantID string, names []string) (map[string]string, error) {
	var response struct {
		Known map[string]struct {
			Category string `json:"category"`
		} `json:"known"`
		Unknown []string `json:"unknown"`
	}
	if err := c.post(ctx, tenantID, "/api/secrets/metadata", map[string]any{"names": names}, &response); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for name, entry := range response.Known {
		if _, ok := allowedCategories[entry.Category]; !ok {
			return nil, fmt.Errorf("metadata returned invalid category for %q", name)
		}
		out[name] = entry.Category
	}
	return out, nil
}

func (c httpPlatformSecretsClient) ListMetadata(ctx context.Context, tenantID string) ([]secretMetadata, error) {
	var response []secretMetadata
	if err := c.post(ctx, tenantID, "/api/secrets/list", map[string]any{}, &response); err != nil {
		return nil, err
	}
	for _, entry := range response {
		if !secretNameRE.MatchString(entry.Name) {
			return nil, fmt.Errorf("list returned invalid secret name %q", entry.Name)
		}
		if _, ok := allowedCategories[entry.Category]; !ok {
			return nil, fmt.Errorf("list returned invalid category for %q", entry.Name)
		}
	}
	return response, nil
}

func (c httpPlatformSecretsClient) Resolve(ctx context.Context, tenantID string, names []string, tool string) (resolvedSecretSet, error) {
	var response struct {
		Resolved   map[string]string `json:"resolved"`
		Categories map[string]string `json:"categories"`
		Missing    []string          `json:"missing"`
	}
	if err := c.post(ctx, tenantID, "/api/secrets/resolve", map[string]any{"names": names, "tool": tool}, &response); err != nil {
		return resolvedSecretSet{}, err
	}
	return resolvedSecretSet{
		Values:     response.Resolved,
		Categories: response.Categories,
		Missing:    response.Missing,
	}, nil
}

func (c httpPlatformSecretsClient) post(ctx context.Context, tenantID string, apiPath string, body any, out any) error {
	if strings.TrimSpace(tenantID) == "" {
		return errors.New("ROCKIELAB_TENANT_ID is required for secret runtime operations")
	}
	token := platformBrokerToken()
	if token == "" {
		return errors.New("broker token is required for secret runtime operations")
	}
	base := strings.TrimRight(os.Getenv("ROCKIELAB_API_BASE"), "/")
	if base == "" {
		base = "https://api.rockielab.com"
	}
	parsed, err := url.Parse(base + apiPath)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Tenant-Id", tenantID)
	client := c.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		tail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("platform secrets API %s failed: %s", apiPath, strings.TrimSpace(string(tail)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func platformBrokerToken() string {
	if token := strings.TrimSpace(os.Getenv("ROCKIELAB_BROKER_TOKEN")); token != "" {
		return token
	}
	return strings.TrimSpace(os.Getenv("BROKER_TENANT_TOKEN"))
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

type secretRedactor struct {
	values map[string]string
}

func newSecretRedactor(values map[string]string) *secretRedactor {
	copied := map[string]string{}
	for name, value := range values {
		if value != "" {
			copied[name] = value
		}
	}
	return &secretRedactor{values: copied}
}

func (r *secretRedactor) Redact(text string) string {
	out := text
	for name, value := range r.values {
		out = strings.ReplaceAll(out, value, "<redacted:"+name+">")
	}
	return out
}

func (r *secretRedactor) Close() {
	for name := range r.values {
		delete(r.values, name)
	}
}
