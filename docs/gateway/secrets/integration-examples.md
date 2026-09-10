---
summary: "Exec provider recipes for external secret managers, MCP server environment variables, and sandbox SSH"
read_when:
  - Wiring an external secret manager through the exec provider
  - Passing secrets to MCP servers or sandbox SSH auth material
title: "Secrets integration examples"
---

This page collects working integration examples: exec provider recipes for external secret managers, MCP server environment variables, and sandbox SSH auth material.

## Exec integration examples

For a dedicated 1Password guide covering service accounts, the bundled agent skill, and troubleshooting, see [1Password](/gateway/1password).

<AccordionGroup>
  <Accordion title="1Password">
    ```json5
    {
      plugins: {
        entries: {
          onepassword: {
            enabled: true,
          },
        },
      },
      secrets: {
        providers: {
          onepassword: {
            source: "exec",
            pluginIntegration: {
              pluginId: "onepassword",
              integrationId: "onepassword",
            },
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: {
              source: "exec",
              provider: "onepassword",
              id: "op://Engineering/OpenAI/apiKey",
            },
          },
        },
      },
    }
    ```

    The bundled [1Password plugin](/plugins/onepassword) uses the official
    `op` CLI and the plugin's service-account token file.

  </Accordion>
  <Accordion title="Bitwarden Secrets Manager (`bws`)">
    Use a resolver wrapper to map SecretRef ids to Bitwarden Secrets Manager item keys. The repository includes `scripts/secrets/openclaw-bws-resolver.mjs`; install or copy it to an absolute trusted path on the host that runs the Gateway.

    Requirements:

    - Bitwarden Secrets Manager CLI (`bws`) installed on the Gateway host.
    - `BWS_ACCESS_TOKEN` available to the Gateway service.
    - `PATH` passed to the resolver, or `BWS_BIN` set to the absolute `bws` binary path.
    - `BWS_SERVER_URL` set in the environment when using a self-hosted Bitwarden instance.

    ```json5
    {
      secrets: {
        providers: {
          bws: {
            source: "exec",
            command: "/usr/local/bin/openclaw-bws-resolver.mjs",
            passEnv: ["BWS_ACCESS_TOKEN", "BWS_SERVER_URL", "PATH", "BWS_BIN"],
            jsonOnly: true,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: {
              source: "exec",
              provider: "bws",
              id: "openclaw/providers/openai/apiKey",
            },
          },
        },
      },
    }
    ```

    The resolver batches requested ids, runs `bws secret list`, and returns values for matching secret `key` fields. Use keys that satisfy the exec SecretRef id contract, such as `openclaw/providers/openai/apiKey`; env-var-style keys with underscores are rejected before the resolver runs. If more than one visible Bitwarden secret shares the requested key, the resolver fails that id as ambiguous instead of guessing. After updating config, verify the resolver path:

    ```bash
    openclaw secrets audit --allow-exec
    ```

  </Accordion>
  <Accordion title="HashiCorp Vault CLI">
    ```json5
    {
      secrets: {
        providers: {
          vault_openai: {
            source: "exec",
            command: "/absolute/non-symlink/path/to/vault",
            trustedDirs: ["/absolute/non-symlink/path/to"],
            args: ["kv", "get", "-field=OPENAI_API_KEY", "secret/openclaw"],
            passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
            jsonOnly: false,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: { source: "exec", provider: "vault_openai", id: "value" },
          },
        },
      },
    }
    ```
  </Accordion>
  <Accordion title="password-store (`pass`)">
    Use a small resolver wrapper to map SecretRef ids directly to `pass` entries. Save this as an executable at an absolute path that passes your exec-provider path checks, for example `/usr/local/bin/openclaw-pass-resolver`. The `#!/usr/bin/env node` shebang resolves `node` from the resolver process `PATH`, so include `PATH` in `passEnv`. If `pass` is not on that `PATH`, set `PASS_BIN` in the parent environment and include it in `passEnv` too:

    ```js
    #!/usr/bin/env node
    const { spawnSync } = require("node:child_process");

    let stdin = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    process.stdin.on("error", (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
    process.stdin.on("end", () => {
      let request;
      try {
        request = JSON.parse(stdin || "{}");
      } catch (err) {
        process.stderr.write(`Failed to parse request: ${err.message}\n`);
        process.exit(1);
      }

      const passBin = process.env.PASS_BIN || "pass";
      const values = {};
      const errors = {};

      for (const id of request.ids ?? []) {
        const result = spawnSync(passBin, ["show", id], { encoding: "utf8" });
        if (result.status === 0) {
          values[id] = result.stdout.split(/\r?\n/, 1)[0] ?? "";
        } else {
          errors[id] = { message: (result.stderr || `pass exited ${result.status}`).trim() };
        }
      }

      process.stdout.write(JSON.stringify({ protocolVersion: 1, values, errors }));
    });
    ```

    Then configure the exec provider and point `apiKey` at the `pass` entry path:

    ```json5
    {
      secrets: {
        providers: {
          pass_store: {
            source: "exec",
            command: "/usr/local/bin/openclaw-pass-resolver",
            passEnv: ["PATH", "HOME", "GNUPGHOME", "GPG_TTY", "PASSWORD_STORE_DIR", "PASS_BIN"],
            jsonOnly: true,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: {
              source: "exec",
              provider: "pass_store",
              id: "openclaw/providers/openai/apiKey",
            },
          },
        },
      },
    }
    ```

    Keep the secret on the first line of the `pass` entry, or customize the wrapper to return the full `pass show` output instead. After updating config, verify both the static audit and the exec resolver path:

    ```bash
    openclaw secrets audit --check
    openclaw secrets audit --allow-exec
    ```

  </Accordion>
  <Accordion title="sops">
    ```json5
    {
      secrets: {
        providers: {
          sops_openai: {
            source: "exec",
            command: "/absolute/non-symlink/path/to/sops",
            trustedDirs: ["/absolute/non-symlink/path/to"],
            args: ["-d", "--extract", '["providers"]["openai"]["apiKey"]', "/path/to/secrets.enc.json"],
            passEnv: ["SOPS_AGE_KEY_FILE"],
            jsonOnly: false,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            apiKey: { source: "exec", provider: "sops_openai", id: "value" },
          },
        },
      },
    }
    ```
  </Accordion>
</AccordionGroup>

## MCP server environment variables

MCP server env vars configured via `plugins.entries.acpx.config.mcpServers` accept SecretInput, keeping API keys and tokens out of plaintext config:

```json5
{
  plugins: {
    entries: {
      acpx: {
        enabled: true,
        config: {
          mcpServers: {
            github: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: {
                GITHUB_PERSONAL_ACCESS_TOKEN: {
                  source: "env",
                  provider: "default",
                  id: "MCP_GITHUB_PAT",
                },
              },
            },
          },
        },
      },
    },
  },
}
```

Plaintext string values still work. Env-template refs like `${MCP_SERVER_API_KEY}` and SecretRef objects resolve during gateway activation, before the MCP server process spawns. As with other SecretRef surfaces, unresolved refs only block activation when the `acpx` plugin is effectively active.

## Sandbox SSH auth material

The core `ssh` sandbox backend also supports SecretRefs for SSH auth material:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "ssh",
        ssh: {
          target: "user@gateway-host:22",
          identityData: { source: "env", provider: "default", id: "SSH_IDENTITY" },
          certificateData: { source: "env", provider: "default", id: "SSH_CERTIFICATE" },
          knownHostsData: { source: "env", provider: "default", id: "SSH_KNOWN_HOSTS" },
        },
      },
    },
  },
}
```

Runtime behavior:

- OpenClaw resolves these refs during sandbox activation, not lazily on each SSH call.
- Resolved values are written to a temp directory with restrictive file permissions (`0o600`) and used in the generated SSH config.
- If the effective sandbox backend is not `ssh` (or sandbox mode is `off`), these refs stay inactive and do not block startup.
