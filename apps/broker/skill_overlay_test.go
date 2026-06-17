package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// authedSkillWrite builds an authenticated POST /fs/skill-write request with a
// JSON body. Mirrors authedFSRequest's broker-token + tenant-id setup.
func authedSkillWrite(t *testing.T, body string) *http.Request {
	t.Helper()
	t.Setenv("BROKER_TENANT_TOKEN", "tok")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	req := httptest.NewRequest(http.MethodPost, "/fs/skill-write", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	return req
}

func skillRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	skills := filepath.Join(root, ".claude", "skills")
	t.Setenv("OPENCLAW_SKILLS_DIR", skills)
	return skills
}

func TestSkillWriteHappyPathMultiFile(t *testing.T) {
	skills := skillRoot(t)
	body := `{"name":"my-skill","files":[
		{"path":"SKILL.md","content":"# my skill"},
		{"path":"scripts/run.sh","content":"echo hi"}
	]}`
	rec := httptest.NewRecorder()
	skillWriteHandler(rec, authedSkillWrite(t, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp skillWriteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.FilesWritten != 2 {
		t.Fatalf("expected 2 files written, got %d", resp.FilesWritten)
	}
	// Files landed on disk under the overlay.
	got, err := os.ReadFile(filepath.Join(skills, "my-skill", "SKILL.md"))
	if err != nil || string(got) != "# my skill" {
		t.Fatalf("SKILL.md content wrong: %q err=%v", got, err)
	}
	got2, err := os.ReadFile(filepath.Join(skills, "my-skill", "scripts", "run.sh"))
	if err != nil || string(got2) != "echo hi" {
		t.Fatalf("run.sh content wrong: %q err=%v", got2, err)
	}
}

func TestSkillWriteReplacesExistingDirWholesale(t *testing.T) {
	skills := skillRoot(t)
	// Pre-seed a stale file that should be gone after the replacing push.
	if err := os.MkdirAll(filepath.Join(skills, "s1"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skills, "s1", "STALE.md"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	skillWriteHandler(rec, authedSkillWrite(t, `{"name":"s1","files":[{"path":"SKILL.md","content":"new"}]}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(skills, "s1", "STALE.md")); !os.IsNotExist(err) {
		t.Fatalf("stale file should have been removed, err=%v", err)
	}
}

func TestSkillWriteRejectsBadNames(t *testing.T) {
	skillRoot(t)
	for _, name := range []string{"", "..", "Bad", "1abc", "-abc", "a/b", "a..b", strings.Repeat("a", 65)} {
		body := `{"name":` + jsonStr(name) + `,"files":[{"path":"SKILL.md","content":"x"}]}`
		rec := httptest.NewRecorder()
		skillWriteHandler(rec, authedSkillWrite(t, body))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("name %q should be rejected, got %d body=%s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestSkillWriteRejectsPathTraversal(t *testing.T) {
	skills := skillRoot(t)
	// A sibling file the attacker would try to clobber via traversal.
	if err := os.MkdirAll(filepath.Dir(skills), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{
		"../escape.md",
		"../../escape.md",
		"/etc/passwd",
		`..\escape.md`,
		`scripts\escape.md`,
		"scripts/../../escape.md",
		"a/../../escape.md",
	} {
		body := `{"name":"ok","files":[{"path":` + jsonStr(p) + `,"content":"x"}]}`
		rec := httptest.NewRecorder()
		skillWriteHandler(rec, authedSkillWrite(t, body))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("path %q should be rejected, got %d body=%s", p, rec.Code, rec.Body.String())
		}
	}
	// Nothing escaped the overlay skill dir.
	if _, err := os.Stat(filepath.Join(filepath.Dir(skills), "escape.md")); !os.IsNotExist(err) {
		t.Fatalf("traversal wrote outside overlay, err=%v", err)
	}
}

// A symlink pre-planted in the LIVE skill dir must never be followed: the push
// stages into a fresh dir we own and swaps it in, so the live dir (with its
// symlink) is replaced wholesale, never written through.
func TestSkillWriteIgnoresPrePlantedLiveSymlink(t *testing.T) {
	skills := skillRoot(t)
	outside := t.TempDir()
	skillDir := filepath.Join(skills, "ok")
	if err := os.MkdirAll(skillDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// Pre-plant a symlink subdir that points outside the overlay.
	if err := os.Symlink(outside, filepath.Join(skillDir, "out")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	body := `{"name":"ok","files":[{"path":"out/escape.md","content":"x"}]}`
	rec := httptest.NewRecorder()
	skillWriteHandler(rec, authedSkillWrite(t, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 (live symlink replaced, not followed), got %d body=%s", rec.Code, rec.Body.String())
	}
	// The write landed inside the overlay skill dir, NOT through the old symlink.
	got, err := os.ReadFile(filepath.Join(skills, "ok", "out", "escape.md"))
	if err != nil || string(got) != "x" {
		t.Fatalf("file should be inside overlay: %q err=%v", got, err)
	}
	// Nothing escaped to the outside dir.
	if _, err := os.Stat(filepath.Join(outside, "escape.md")); !os.IsNotExist(err) {
		t.Fatalf("write escaped outside overlay via symlink, err=%v", err)
	}
	// And the replacement is a real dir, not a symlink.
	info, err := os.Lstat(filepath.Join(skills, "ok", "out"))
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("out should be a real dir, not a symlink: mode=%v err=%v", info.Mode(), err)
	}
}

func TestSkillWriteRejectsInvalidUTF8Body(t *testing.T) {
	skillRoot(t)
	body := []byte(`{"name":"ok","files":[{"path":"SKILL.md","content":"`)
	body = append(body, 0xff)
	body = append(body, []byte(`"}]}`)...)
	req := httptest.NewRequest(http.MethodPost, "/fs/skill-write", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	t.Setenv("BROKER_TENANT_TOKEN", "tok")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	rec := httptest.NewRecorder()
	skillWriteHandler(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("invalid UTF-8 body should be 415, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSkillWriteRejectsOversize(t *testing.T) {
	skillRoot(t)
	big := strings.Repeat("a", skillMaxFileBytes+1)
	body := `{"name":"ok","files":[{"path":"SKILL.md","content":` + jsonStr(big) + `}]}`
	rec := httptest.NewRecorder()
	skillWriteHandler(rec, authedSkillWrite(t, body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize file should be 413, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSkillWriteRequiresAuth(t *testing.T) {
	skillRoot(t)
	t.Setenv("BROKER_TENANT_TOKEN", "tok")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	req := httptest.NewRequest(http.MethodPost, "/fs/skill-write",
		strings.NewReader(`{"name":"ok","files":[{"path":"SKILL.md","content":"x"}]}`))
	// No Authorization header.
	rec := httptest.NewRecorder()
	skillWriteHandler(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token should be 401, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSkillWriteRejectsGET(t *testing.T) {
	skillRoot(t)
	req := authedSkillWrite(t, "")
	req.Method = http.MethodGet
	rec := httptest.NewRecorder()
	skillWriteHandler(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET should be 405, got %d", rec.Code)
	}
}

// jsonStr marshals s as a JSON string literal (with quotes) for inline bodies.
func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
