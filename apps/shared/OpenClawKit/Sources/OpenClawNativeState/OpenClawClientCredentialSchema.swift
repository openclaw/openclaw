enum OpenClawClientCredentialSchema {
    static let version: Int64 = 1

    /// Keep this independent local format aligned with src/infra/client-credential-schema.ts.
    static let statements: [String] = [
        """
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY,
          device_id TEXT NOT NULL,
          public_key_pem TEXT NOT NULL,
          private_key_pem TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT
        """,
        """
        CREATE INDEX idx_device_identities_device
          ON device_identities(device_id, updated_at_ms DESC)
        """,
        """
        CREATE TABLE device_auth_tokens (
          device_id TEXT NOT NULL,
          role TEXT NOT NULL,
          token TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (device_id, role)
        ) STRICT
        """,
        """
        CREATE INDEX idx_device_auth_tokens_updated
          ON device_auth_tokens(updated_at_ms DESC, device_id, role)
        """,
        """
        CREATE TABLE gateway_origin_device_tokens (
          gateway_scope TEXT NOT NULL,
          device_id TEXT NOT NULL,
          role TEXT NOT NULL,
          token TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (gateway_scope, device_id, role)
        ) STRICT
        """,
        """
        CREATE TABLE native_exec_socket_credentials (
          socket_key TEXT NOT NULL PRIMARY KEY CHECK (socket_key = 'current'),
          socket_path TEXT,
          socket_token TEXT,
          updated_at_ms INTEGER NOT NULL
        ) STRICT
        """,
        """
        CREATE TABLE client_credential_migration (
          version INTEGER PRIMARY KEY CHECK (version = 1),
          source_store TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('copied', 'complete')),
          updated_at_ms INTEGER NOT NULL
        ) STRICT
        """,
    ]
}
