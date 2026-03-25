import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const execFileAsync = promisify(execFile);
const MAX_QUERY_LEN = 512;

export default {
  id: "windows-search",
  name: "Windows File Search",
  description: "Fast Windows file search using Windows Search Index",
  register(api: OpenClawPluginApi) {
    api.registerTool(
      {
        name: "windows_file_search",
        label: "Windows File Search",
        description: "Search for files quickly using the native Windows Search Index.",
        parameters: Type.Object({
          query: Type.String({ description: "Keyword to search for in filenames." }),
          limit: Type.Optional(
            Type.Number({ description: "Maximum number of results to return (default: 20)." }),
          ),
          extension: Type.Optional(
            Type.String({
              description: "File extension filter, e.g. txt or .txt",
            }),
          ),
          scope: Type.Optional(
            Type.String({
              description: "Limit search to a folder scope, e.g. C:\\\\Users\\\\me\\\\Documents",
            }),
          ),
          days_ago: Type.Optional(
            Type.Number({
              description: "Only include files modified within the last N days.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit = 20,
            extension,
            scope,
            days_ago,
          } = params as {
            query: string;
            limit?: number;
            extension?: string;
            scope?: string;
            days_ago?: number;
          };

          if (process.platform !== "win32") {
            const payload = {
              status: "error",
              code: "unsupported_platform",
              message: "This tool is only available on Windows.",
            };
            return {
              content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
              details: payload,
            };
          }

          const trimmedQuery = String(query ?? "").trim();
          const boundedQuery = trimmedQuery.slice(0, MAX_QUERY_LEN);
          const safeQuery = boundedQuery
            .replace(/[\r\n]/g, " ")
            .replace(/"/g, '""')
            .replace(/'/g, "''");
          const safeLimit = Math.max(1, Math.min(1000, limit));
          const normalizedExtensionRaw =
            typeof extension === "string"
              ? extension
                  .replace(/[\r\n]/g, " ")
                  .trim()
                  .toLowerCase()
              : "";
          const normalizedExtension =
            normalizedExtensionRaw && !normalizedExtensionRaw.startsWith(".")
              ? `.${normalizedExtensionRaw}`
              : normalizedExtensionRaw;
          const extPattern = /^\.[a-z0-9_-]{1,16}$/;
          const validatedExtension = extPattern.test(normalizedExtension)
            ? normalizedExtension
            : "";
          const safeExtension = validatedExtension
            .replace(/[\r\n]/g, " ")
            .replace(/"/g, '""')
            .replace(/'/g, "''");
          const normalizedScopeRaw =
            typeof scope === "string" ? scope.replace(/[\r\n]/g, " ").trim() : "";
          const normalizedScope = normalizeWindowsSearchScope(normalizedScopeRaw);
          const safeScope = normalizedScope
            .replace(/[\r\n]/g, " ")
            .replace(/"/g, '""')
            .replace(/'/g, "''");
          const safeDaysAgo =
            typeof days_ago === "number" && Number.isFinite(days_ago)
              ? Math.max(0, Math.min(3650, Math.floor(days_ago)))
              : 0;

          const psScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$wsearch = Get-Service -Name WSearch -ErrorAction SilentlyContinue
if (-not $wsearch -or $wsearch.Status -ne 'Running') {
    Write-Output "ERROR:WSEARCH_NOT_RUNNING"
    exit 0
}
$query = '${safeQuery}'
$ext = '${safeExtension}'
$scope = '${safeScope}'
$daysAgo = ${safeDaysAgo}
$limit = ${safeLimit}
$queryLike = $query.Replace("'", "''").Replace("\\", "\\\\").Replace("_", "\\_").Replace("%", "\\%").Replace("[", "\\[").Replace("]", "\\]").Replace("*", "\\*")
try {
    $con = New-Object -ComObject ADODB.Connection
    $rs = New-Object -ComObject ADODB.Recordset
    $con.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
    $whereParts = @()
    $whereParts += "System.FileName LIKE '%$queryLike%' ESCAPE '\\\\'"
    if ($scope) {
        $scopeSql = $scope.Replace("'", "''")
        $whereParts += "SCOPE = '$scopeSql'"
    }
    if ($ext -and $ext -ne '.') {
        $extSql = $ext.Replace("'", "''")
        $whereParts += "System.FileExtension = '$extSql'"
    }
    if ($daysAgo -gt 0) {
        $from = (Get-Date).AddDays(-$daysAgo).ToString("yyyy-MM-ddTHH:mm:ss")
        $whereParts += "System.DateModified >= '$from'"
    }
    $where = $whereParts -join " AND "
    $sql = "SELECT TOP $limit System.ItemPathDisplay FROM SystemIndex WHERE $where"
    $rs.Open($sql, $con)
    $results = @()
    while (-not $rs.EOF) {
        $results += $rs.Fields.Item("System.ItemPathDisplay").Value
        $rs.MoveNext()
    }
    $rs.Close()
    $con.Close()
    $results -join "\`n"
} catch {
    Write-Output "ERROR:ADODB_FAILED"
    exit 0
}
          `;

          try {
            const inlineScript = psScript
              .trim()
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .join("; ");
            const { stdout } = await execFileAsync(
              "powershell.exe",
              ["-NoProfile", "-Command", inlineScript],
              { maxBuffer: 1024 * 1024 * 10, encoding: "utf8" },
            );

            if (stdout.includes("ERROR:WSEARCH_NOT_RUNNING")) {
              const payload = {
                status: "error",
                code: "service_not_running",
                message: "Windows Search service is not running (WSearch).",
                hint: "Open services.msc → start Windows Search → try again.",
              };
              return {
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                details: payload,
              };
            }

            if (stdout.includes("ERROR:ADODB_FAILED")) {
              const payload = {
                status: "error",
                code: "adodb_failed",
                message: "Failed to query the Windows Search Index (Search.CollatorDSO).",
                hint: "Open Indexing Options → check status → Advanced → Rebuild (if needed).",
              };
              return {
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                details: payload,
              };
            }

            const files = stdout
              .trim()
              .split(/\r?\n/)
              .map((f) => f.trim())
              .filter((f) => f && !f.startsWith("ERROR:"));

            const effective = {
              limit: safeLimit,
              extension: normalizedExtension || undefined,
              scope: normalizedScope || undefined,
              days_ago: safeDaysAgo || undefined,
            };

            if (files.length === 0) {
              const payload = {
                status: "ok",
                query,
                count: 0,
                files: [] as string[],
                effective,
              };
              return {
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                details: payload,
              };
            }

            const payload = {
              status: "ok",
              query,
              count: files.length,
              files,
              effective,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
              details: payload,
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const error =
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack }
                : { message: String(err) };
            api.logger.warn(
              JSON.stringify({
                event: "windows_search_failed",
                code: "search_failed",
                error,
                context: {
                  limit: safeLimit,
                  days_ago: safeDaysAgo,
                  has_scope: Boolean(normalizedScope),
                  has_extension: Boolean(validatedExtension),
                },
              }),
            );
            const payload = {
              status: "error",
              code: "search_failed",
              message,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
              details: payload,
            };
          }
        },
      },
      { name: "windows_file_search" },
    );
  },
};

function normalizeWindowsSearchScope(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return "";
  }

  const filePrefix = raw.match(/^file:(\/\/\/|\/\/)?/i);
  let rest = raw;
  if (filePrefix) {
    rest = raw.slice(filePrefix[0].length);
  }

  const unc = rest.match(/^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/);
  if (unc) {
    const host = unc[1];
    const share = unc[2];
    const tail = (unc[3] ?? "").replace(/\\/g, "/");
    const path = `${share}${tail}`.replace(/^\/+/, "").replace(/\/+$/g, "") + "/";
    return `file://${host}/${path}`;
  }

  const drive = rest.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (drive) {
    const letter = drive[1].toUpperCase();
    const tail = drive[2].replace(/\\/g, "/");
    const path = `${letter}:/${tail}`.replace(/\/+$/g, "") + "/";
    return `file:${path}`;
  }

  const forward = rest.replace(/\\/g, "/");
  const cleaned = forward.replace(/^\/+/, "").replace(/\/+$/g, "") + "/";
  return `file:${cleaned}`;
}
