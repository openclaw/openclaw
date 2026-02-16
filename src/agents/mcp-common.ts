export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNameValuePairs(value: unknown): Record<string, string> {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  }
  if (!Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const data = typeof entry.value === "string" ? entry.value : "";
    if (!name) {
      continue;
    }
    out[name] = data;
  }
  return out;
}

function hasName(name: string, existing: Record<string, unknown> | Set<string>): boolean {
  return existing instanceof Set ? existing.has(name) : name in existing;
}

export function resolveUniqueMcpName(
  name: string,
  existing: Record<string, unknown> | Set<string>,
): string {
  if (!hasName(name, existing)) {
    return name;
  }
  let next = 2;
  while (hasName(`${name}-${next}`, existing)) {
    next += 1;
  }
  return `${name}-${next}`;
}

export function parseMcpServers(mcpServers: unknown[] | undefined): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (!Array.isArray(mcpServers)) {
    return out;
  }

  for (const rawServer of mcpServers) {
    if (!isRecord(rawServer)) {
      continue;
    }
    const baseName = typeof rawServer.name === "string" ? rawServer.name.trim() : "";
    if (!baseName) {
      continue;
    }
    const name = resolveUniqueMcpName(baseName, out);
    const type = typeof rawServer.type === "string" ? rawServer.type.trim().toLowerCase() : "";

    if (type === "http" || type === "sse") {
      const url = typeof rawServer.url === "string" ? rawServer.url.trim() : "";
      if (!url) {
        continue;
      }
      const headers = readNameValuePairs(rawServer.headers);
      out[name] = {
        type,
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
      continue;
    }

    const command = typeof rawServer.command === "string" ? rawServer.command.trim() : "";
    if (!command) {
      continue;
    }
    const args = Array.isArray(rawServer.args)
      ? rawServer.args.filter((entry): entry is string => typeof entry === "string")
      : [];
    const env = readNameValuePairs(rawServer.env);
    out[name] = {
      type: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  return out;
}
