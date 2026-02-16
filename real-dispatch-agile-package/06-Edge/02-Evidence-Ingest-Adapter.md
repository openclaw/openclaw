# Evidence ingestion adapter

## Flow

1. `evidence.presignUpload` (DispatchCommand) returns presigned PUT URL and constraints.
2. Client uploads to object storage.
3. `evidence.finalizeUpload` validates sha256 and size; records EvidenceRecord.
4. Evidence links to ticket and relevant workflow stage.

## Retention + immutability

- map retention class to object lock policy where supported
- redaction produces derived redacted object; original remains immutable
