package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Per-tenant writable skill OVERLAY support.
//
// The overlay lives at `$HOME/.claude/skills/<name>/` on the tenant's Fly
// volume — the same dir overlay/multitenant/sync-user-skills.sh materializes
// into and the agent auto-loads. This is DISTINCT from the operator-global
// read-only platform-skills baked into the image; we only ever touch the
// per-tenant overlay here.
//
// Reads reuse the existing confined `/fs/tree` + `/fs/file` handlers (the
// caller lists `<skillsRoot>` then GETs each file). The only new surface is
// `POST /fs/skill-write`, which writes a single skill directory.
//
// SECURITY: every write is confined to `<skillsRoot>/<name>/`. The skill name
// is a strict slug; each file's relative path is cleaned and re-checked to be
// under the skill dir (so `..`, absolute paths, and symlink escapes are all
// rejected). The broker is the authoritative confinement boundary — even if a
// caller upstream were tricked, a path that escapes the overlay is refused
// here. Auth is the same broker-token + tenant-id gate as the other /fs routes.

const (
	// Caps to bound abuse of the write path. A skill is documentation +
	// small scripts; these are generous but finite.
	skillMaxFiles         = 64
	skillMaxFileBytes     = 256 * 1024      // 256 KiB per file
	skillMaxTotalBytes    = 2 * 1024 * 1024 // 2 MiB per skill dir
	skillWriteMaxBodyByte = 4 * 1024 * 1024 // hard cap on the request body
)

// skillsOverlayRoot is the writable per-tenant skills overlay dir. Mirrors the
// runtime's OPENCLAW_SKILLS_DIR resolution (overlay/multitenant/sync-user-skills.sh)
// so we write where the agent actually loads from.
func skillsOverlayRoot() string {
	if d := os.Getenv("OPENCLAW_SKILLS_DIR"); d != "" {
		return d
	}
	home := os.Getenv("HOME")
	if home == "" {
		home = "/home/runtime"
	}
	return filepath.Join(home, ".claude", "skills")
}

// skillNameRe-equivalent: a strict slug, matching the server-side and
// sync-user-skills.sh validation (`^[a-z][a-z0-9-]{0,63}$`). Implemented
// without regexp to keep the dependency surface minimal and the check obvious.
func validSkillName(name string) bool {
	if len(name) == 0 || len(name) > 64 {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
			if i == 0 {
				return false
			}
		case r == '-':
			if i == 0 {
				return false
			}
		default:
			return false
		}
	}
	return true
}

type skillWriteFile struct {
	// Path RELATIVE to the skill dir, POSIX-style (e.g. "SKILL.md",
	// "scripts/run.sh"). Never absolute, never containing "..".
	Path    string `json:"path"`
	Content string `json:"content"`
}

type skillWriteRequest struct {
	Name  string           `json:"name"`
	Files []skillWriteFile `json:"files"`
}

type skillWriteResponse struct {
	Name         string `json:"name"`
	Path         string `json:"path"`
	FilesWritten int    `json:"files_written"`
	BytesWritten int64  `json:"bytes_written"`
}

// cleanSkillRelPath validates one file's relative path LEXICALLY and returns
// the normalized relative path under the skill dir. It rejects absolute paths,
// backslashes, "..", NUL bytes, and any path whose cleaned form escapes the dir.
//
// The check is purely string-based here (no filesystem touch) because the skill
// dir does not exist yet at plan time — the authoritative symlink-escape guard
// runs at write time against the staging dir we own (see skillWriteHandler).
func cleanSkillRelPath(rel string) (string, error) {
	if rel == "" {
		return "", errors.New("empty_path")
	}
	if strings.ContainsRune(rel, '\x00') {
		return "", errors.New("invalid_path")
	}
	if strings.Contains(rel, "\\") {
		return "", errors.New("backslash_path")
	}
	// Normalize separators; refuse Windows-style and absolute inputs outright.
	rel = filepath.ToSlash(rel)
	if strings.HasPrefix(rel, "/") || filepath.IsAbs(rel) {
		return "", errors.New("absolute_path")
	}
	// filepath.Clean collapses "." and resolves internal ".."; a result that
	// still starts with ".." (or equals "..") escapes the dir.
	cleaned := filepath.Clean(filepath.FromSlash(rel))
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) || cleaned == "." {
		return "", errors.New("path_escape")
	}
	return cleaned, nil
}

// skillWriteHandler writes one skill directory under the tenant's overlay.
//
// POST /fs/skill-write  {"name": "...", "files": [{"path": "...", "content": "..."}]}
//
// The write is staged into a sibling temp dir and swapped in, so a partially
// written skill never shadows the live one. Pre-existing files for the same
// skill name are replaced wholesale (the push is the new source of truth for
// that skill dir).
func skillWriteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only POST is allowed on /fs/skill-write")
		return
	}
	if !requireBrokerRequest(w, r) {
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, skillWriteMaxBodyByte+1))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "read_failed", "could not read request body")
		return
	}
	if int64(len(body)) > skillWriteMaxBodyByte {
		jsonError(w, http.StatusRequestEntityTooLarge, "body_too_large",
			"request body exceeds the skill-write limit")
		return
	}
	if !utf8.Valid(body) {
		jsonError(w, http.StatusUnsupportedMediaType, "unsupported_file",
			"request body is not valid UTF-8")
		return
	}

	var req skillWriteRequest
	if err := json.Unmarshal(body, &req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid_json", "request body is not valid JSON")
		return
	}
	if !validSkillName(req.Name) {
		jsonError(w, http.StatusBadRequest, "invalid_skill_name",
			"skill name must match ^[a-z][a-z0-9-]{0,63}$")
		return
	}
	if len(req.Files) == 0 {
		jsonError(w, http.StatusBadRequest, "no_files", "at least one file is required")
		return
	}
	if len(req.Files) > skillMaxFiles {
		jsonError(w, http.StatusRequestEntityTooLarge, "too_many_files",
			"skill has too many files")
		return
	}

	root := skillsOverlayRoot()
	skillDir := filepath.Join(root, req.Name)

	// Validate every file path + size BEFORE touching the filesystem, so a bad
	// entry aborts the whole push with nothing written.
	type plannedFile struct {
		rel     string // cleaned path relative to the skill dir
		content []byte
	}
	planned := make([]plannedFile, 0, len(req.Files))
	var total int64
	seen := make(map[string]struct{}, len(req.Files))
	for _, f := range req.Files {
		rel, err := cleanSkillRelPath(f.Path)
		if err != nil {
			jsonError(w, http.StatusBadRequest, "invalid_path",
				"file path "+f.Path+" is not allowed: "+err.Error())
			return
		}
		if _, dup := seen[rel]; dup {
			jsonError(w, http.StatusBadRequest, "duplicate_path",
				"duplicate file path: "+f.Path)
			return
		}
		seen[rel] = struct{}{}
		content := []byte(f.Content)
		if int64(len(content)) > skillMaxFileBytes {
			jsonError(w, http.StatusRequestEntityTooLarge, "file_too_large",
				"file "+f.Path+" exceeds the per-file limit")
			return
		}
		if !utf8.Valid(content) {
			jsonError(w, http.StatusUnsupportedMediaType, "unsupported_file",
				"file "+f.Path+" is not valid UTF-8")
			return
		}
		total += int64(len(content))
		if total > skillMaxTotalBytes {
			jsonError(w, http.StatusRequestEntityTooLarge, "skill_too_large",
				"skill exceeds the total-size limit")
			return
		}
		planned = append(planned, plannedFile{rel: rel, content: content})
	}

	if err := os.MkdirAll(root, 0o700); err != nil {
		jsonError(w, http.StatusInternalServerError, "write_failed",
			"could not create skills overlay root")
		return
	}

	// Stage into a sibling temp dir, then swap. Keeps the live skill intact on
	// any mid-write failure.
	staging, err := os.MkdirTemp(root, "."+req.Name+".staging-")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "write_failed",
			"could not create staging dir")
		return
	}
	cleanupStaging := true
	defer func() {
		if cleanupStaging {
			_ = os.RemoveAll(staging)
		}
	}()

	// Resolve the staging root once so the per-file symlink-escape guard below
	// compares fully-resolved paths.
	resolvedStaging, err := filepath.EvalSymlinks(staging)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "write_failed", "could not resolve staging dir")
		return
	}

	var written int64
	for _, p := range planned {
		stagedDest := filepath.Join(staging, p.rel)
		if err := os.MkdirAll(filepath.Dir(stagedDest), 0o700); err != nil {
			jsonError(w, http.StatusInternalServerError, "write_failed", "could not create file dir")
			return
		}
		// Authoritative symlink-escape guard: the parent dir now exists, so
		// resolve it and confirm it is still under the staging root. A symlink
		// planted by an earlier file in this same push cannot redirect a write
		// outside the dir we own.
		resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(stagedDest))
		if err != nil || !pathIsUnderRoot(resolvedStaging, resolvedParent) {
			jsonError(w, http.StatusBadRequest, "invalid_path", "file path escapes the skill dir")
			return
		}
		if err := os.WriteFile(stagedDest, p.content, 0o600); err != nil {
			jsonError(w, http.StatusInternalServerError, "write_failed", "could not write file")
			return
		}
		written += int64(len(p.content))
	}

	// Swap: remove any existing skill dir, then rename staging into place.
	if err := os.RemoveAll(skillDir); err != nil {
		jsonError(w, http.StatusInternalServerError, "write_failed", "could not replace existing skill")
		return
	}
	if err := os.Rename(staging, skillDir); err != nil {
		jsonError(w, http.StatusInternalServerError, "write_failed", "could not finalize skill")
		return
	}
	cleanupStaging = false

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(skillWriteResponse{
		Name:         req.Name,
		Path:         filepath.ToSlash(skillDir),
		FilesWritten: len(planned),
		BytesWritten: written,
	})
}
