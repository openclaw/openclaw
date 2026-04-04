# Manus Routing Reference

**App name:** `manus`
**Base URL proxied:** `api.manus.ai`

## API Path Pattern

```
/manus/v1/projects
/manus/v1/tasks
/manus/v1/files
/manus/v1/webhooks
```

## Important Notes

- Connection uses API_KEY authentication method (not OAuth)
- Tasks are executed asynchronously - poll for completion or use webhooks
- File uploads use presigned S3 URLs that expire in ~3 minutes
- Files expire after ~48 hours if not used

## Common Endpoints

### Projects

#### List Projects

```bash
GET /manus/v1/projects
```

#### Create Project

```bash
POST /manus/v1/projects
Content-Type: application/json

{
  "name": "My Project",
  "default_instructions": "You are a helpful assistant."
}
```

### Tasks

#### List Tasks

```bash
GET /manus/v1/tasks
```

#### Get Task

```bash
GET /manus/v1/tasks/{task_id}
```

#### Create Task

```bash
POST /manus/v1/tasks
Content-Type: application/json

{
  "prompt": "What is the capital of France?"
}
```

Optional fields:

- `project_id`: Associate with a project
- `file_ids`: Attach files to the task

#### Delete Task

```bash
DELETE /manus/v1/tasks/{task_id}
```

### Files

#### List Files

```bash
GET /manus/v1/files
```

Returns the 10 most recently uploaded files.

#### Get File

```bash
GET /manus/v1/files/{file_id}
```

#### Create File

```bash
POST /manus/v1/files
Content-Type: application/json

{
  "filename": "document.pdf"
}
```

Returns a presigned S3 upload URL. Upload your file to `upload_url` using PUT.

#### Delete File

```bash
DELETE /manus/v1/files/{file_id}
```

### Webhooks

#### Create Webhook

```bash
POST /manus/v1/webhooks
Content-Type: application/json

{
  "webhook": {
    "url": "https://example.com/webhook"
  }
}
```

Note: The webhook URL must be nested inside a `webhook` object.

#### Delete Webhook

```bash
DELETE /manus/v1/webhooks/{webhook_id}
```

## Task Status Values

- `pending`: Task is queued
- `running`: Task is being executed
- `completed`: Task finished successfully
- `failed`: Task failed

## File Status Values

- `pending`: File record created, awaiting upload
- `ready`: File uploaded and available
- `expired`: File has expired

## Available Models

- `manus-1.6`
- `manus-1.6-lite`
- `manus-1.6-max`
- `manus-1.5`
- `manus-1.5-lite`
- `speed`

## Resources

- [Manus API Overview](https://open.manus.im/docs)
- [Manus API Reference](https://open.manus.im/docs/api-reference)
- [Manus Website](https://manus.im)
