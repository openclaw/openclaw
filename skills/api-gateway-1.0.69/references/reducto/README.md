# Reducto Routing Reference

**App name:** `reducto`
**Base URL proxied:** `platform.reducto.ai`

## API Path Pattern

```
/reducto/parse
/reducto/parse_async
/reducto/extract
/reducto/extract_async
/reducto/split
/reducto/split_async
/reducto/edit
/reducto/edit_async
/reducto/upload
/reducto/pipeline
/reducto/jobs
/reducto/job/{job_id}
/reducto/version
```

## Important Notes

- Connection uses API_KEY authentication method (not OAuth)
- Use async endpoints for large documents to avoid timeouts
- Upload presigned URLs expire quickly
- Use `reducto://` URLs from upload in subsequent requests
- Use `jobid://` to reuse parsed content from previous jobs

## Common Endpoints

### Parse Document

```bash
POST /reducto/parse
Content-Type: application/json

{
  "document_url": "https://example.com/document.pdf"
}
```

### Parse Document (Async)

```bash
POST /reducto/parse_async
Content-Type: application/json

{
  "document_url": "https://example.com/document.pdf"
}
```

### Extract Data

```bash
POST /reducto/extract
Content-Type: application/json

{
  "document_url": "https://example.com/document.pdf",
  "schema": {
    "type": "object",
    "properties": {
      "title": {"type": "string"},
      "date": {"type": "string"}
    }
  }
}
```

### Split Document

```bash
POST /reducto/split
Content-Type: application/json

{
  "document_url": "https://example.com/document.pdf",
  "split_description": [
    {"name": "section1", "description": "First section"}
  ]
}
```

### Edit Document

```bash
POST /reducto/edit
Content-Type: application/json

{
  "document_url": "https://example.com/form.pdf",
  "edit_instructions": "Fill the name field with 'John Doe'"
}
```

### Upload File

```bash
POST /reducto/upload
Content-Type: application/json

{}
```

### List Jobs

```bash
GET /reducto/jobs
```

### Get Job Status

```bash
GET /reducto/job/{job_id}
```

### Get Version

```bash
GET /reducto/version
```

## Job Status Values

- `Pending`: Job is queued or processing
- `InProgress`: Job is actively processing
- `Completed`: Job finished successfully
- `Failed`: Job failed

## Document URL Formats

- Public URL: `https://example.com/document.pdf`
- Presigned S3: `https://bucket.s3.amazonaws.com/key?...`
- Upload result: `reducto://file-id`
- Previous job: `jobid://job-id`

## Resources

- [Reducto Documentation](https://docs.reducto.ai)
- [Reducto API Reference](https://docs.reducto.ai/api-reference)
- [Reducto Studio](https://studio.reducto.ai)
