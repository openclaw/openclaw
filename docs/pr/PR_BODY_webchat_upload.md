Title: Gateway Web Chat: add image/file upload (attach, drag-drop, paste)

Summary
- Adds attachment support in Gateway web Chat: attach button, drag & drop, and paste-from-clipboard for images.
- Backend: multipart upload endpoint that stores files under the instance media dir and returns MEDIA:/ paths; message API extended to accept media[].
- Frontend: composer queue with file chips, upload progress; message renderer for thumbnails and file tiles.

Motivation
Users of the web console need to share screenshots/logs directly in the browser. Today there is no upload mechanism.

Implementation (draft)
- Backend
  - POST /api/media/upload (multipart, repeatable file field). Saves to ~/.clawdbot/media/inbound/<uuid>.<ext>, returns { files: [{ path: 'MEDIA:/...', mime, name, size }] }.
  - Extend message creation to accept media[] in addition to text.
- Frontend
  - Attach button + hidden input[type=file] multiple.
  - Drag & drop overlay and handlers on composer.
  - Paste handler captures image blobs from clipboard.
  - Attachment queue with progress; after upload, send text + media paths.
  - Message renderer displays thumbnails for images and links for other files.

Config & Limits
- Defaults: 25MB per file; up to 5 files per message. Configurable via gateway config.

Security
- Sanitized filenames; type/size validation; stored under instance media path; served via existing media route (auth/signed URLs as applicable).

Acceptance Criteria
- Drag/paste/attach works; messages show thumbnails or file tiles; assistant receives MEDIA:/path.

Notes
This PR ships as a draft to align on API shape and UI placement. Happy to adjust to the codebase conventions and routing.
