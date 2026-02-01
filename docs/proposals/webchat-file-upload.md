# Gateway Web Chat: Image/File Upload

Status: draft
Owner: @assistant
Scope: Gateway web console (Chat)

## Problem
The Gateway web Chat has no way to send images/files. Users often need to share screenshots/logs during troubleshooting.

## Goals
- Allow users to attach files via: attach button, drag & drop, paste-from-clipboard (images).
- Show selected files as removable chips with upload progress.
- On send, upload files to server and insert a message with media references so assistants receive MEDIA:/path.
- Support multiple files per message.
- Reasonable defaults for limits (20–50MB per item) and allow config override.

## Non-goals
- Inline buttons/interactive UI in messages (not supported on webchat).
- Server-side virus scanning.

## UX
- Add "Attach" icon next to the composer.
- Dragging files over the composer shows a drop overlay.
- Pasting an image inserts it as a pending attachment.
- Each selected file shows: name/size, thumbnail for images, remove (×), progress bar while uploading.
- Pressing Enter (without Shift) sends text + queued attachments.

## API
- POST /api/media/upload (multipart/form-data)
  - fields: file (repeatable), caption (optional, per-file or per-message caption TBD)
  - returns 200 JSON: { files: [ { path: "MEDIA:/path", mime: "image/png", name: "...", size: 12345, width, height } ] }
  - saves files under gateway media path (e.g., ~/.clawdbot/media/inbound/<uuid>.<ext>)
- POST /api/sessions/:sessionId/messages
  - body: { text?: string, media?: [ { path: "MEDIA:/...", caption?: string } ] }
  - server stores transcript and delivers to assistant runtime.

Notes:
- If a single endpoint already exists to send messages, extend it to accept media[]. Otherwise, use two-phase (upload -> send).
- Respect existing auth/session; CSRF as per current gateway conventions.

## Backend
- Add multipart handling (e.g., busboy/multer/fastify-multipart depending on stack).
- Validate content type and size; enforce configurable limits.
- Compute a safe filename; store to media dir; produce absolute server path and MEDIA:/ prefix for assistant.
- For images: attempt to read dimensions (optional) to improve thumbnails.
- Return JSON list of stored files.
- Extend message creation to accept media[]. Persist media metadata alongside messages for rendering.

## Frontend
- Composer component changes:
  - Add hidden <input type="file" multiple> bound to Attach button.
  - Drag & drop overlay and handlers (dragenter/dragover/drop) on composer area.
  - Clipboard paste handler: capture image blobs and add to attachment queue.
  - Attachment queue state: { id, file|blob, name, size, previewURL, status: queued|uploading|done|error, serverPath? }[]
  - On send: for any queued files not uploaded, call /api/media/upload, show per-file progress. Then call send-message with text + media paths.
  - After success: clear input and queue.
- Message renderer: if message.media exists, render thumbnails for images and file tiles for others; clicking downloads the file.

## Config
- gateway.webchat.uploads.maxItemMB (default 25)
- gateway.webchat.uploads.maxFilesPerMessage (default 5)
- gateway.webchat.uploads.accept (default images+generic: "image/*,application/pdf,.zip,.txt")

## Security
- Store under per-instance media directory; do not serve arbitrary FS paths.
- Serve media via controlled route with auth (or signed URLs) to avoid leaking private files.
- Sanitize filenames; block executables by default if desired.

## Acceptance Criteria
- Drag a screenshot into composer -> shows chip -> send -> message appears with thumbnail; assistant receives MEDIA:/path.
- Click attach to select multiple files -> progress -> all appear in transcript.
- Paste an image from clipboard -> becomes attachment and can be sent.
- Oversize file is rejected with a clear error.

## Test Plan
- Unit: multipart handler, limit enforcement, message payload schema.
- E2E: browser test for drag/drop, paste, attach; verify message persistence and media retrieval.

## Open Questions
- Do we want per-file captions? For MVP we can skip.
- Serving media: public path vs. signed URL behind auth — follow current Gateway approach.

## Task Breakdown
- [ ] Backend: media upload endpoint + storage
- [ ] Backend: extend message API to accept media[]
- [ ] Frontend: composer (attach/drag/paste) + queue + progress
- [ ] Frontend: message renderer for media
- [ ] Config + docs
- [ ] Tests
