import { describe, expect, it, vi } from "vitest";
import {
  isAppOnlyMcpTool,
  MCP_APP_MAX_HTML_BYTES,
  parseMcpAppResource,
  parseMcpToolUiMeta,
} from "./mcp-apps.js";

describe("parseMcpToolUiMeta", () => {
  it("parses nested _meta.ui.resourceUri", () => {
    expect(parseMcpToolUiMeta({ ui: { resourceUri: "ui://diagrams/app.html" } })).toEqual({
      resourceUri: "ui://diagrams/app.html",
    });
  });

  it("parses the deprecated flat ui/resourceUri key", () => {
    expect(parseMcpToolUiMeta({ "ui/resourceUri": "ui://server/app.html" })).toEqual({
      resourceUri: "ui://server/app.html",
    });
  });

  it("prefers the nested key over the flat key", () => {
    expect(
      parseMcpToolUiMeta({
        ui: { resourceUri: "ui://server/nested.html" },
        "ui/resourceUri": "ui://server/flat.html",
      }),
    ).toEqual({ resourceUri: "ui://server/nested.html" });
  });

  it("rejects non-ui:// resource URIs", () => {
    expect(parseMcpToolUiMeta({ ui: { resourceUri: "https://evil.example/app.html" } })).toBe(
      undefined,
    );
  });

  it("parses visibility and drops unknown entries", () => {
    expect(parseMcpToolUiMeta({ ui: { visibility: ["app", "model", "wat"] } })).toEqual({
      visibility: ["app", "model"],
    });
  });

  it("preserves an explicitly empty visibility list", () => {
    expect(parseMcpToolUiMeta({ ui: { visibility: [] } })).toEqual({ visibility: [] });
    expect(parseMcpToolUiMeta({ ui: { visibility: ["wat"] } })).toEqual({ visibility: [] });
  });

  it("returns undefined for tools without ui metadata", () => {
    expect(parseMcpToolUiMeta(undefined)).toBe(undefined);
    expect(parseMcpToolUiMeta({})).toBe(undefined);
    expect(parseMcpToolUiMeta({ ui: {} })).toBe(undefined);
  });
});

describe("isAppOnlyMcpTool", () => {
  it("flags tools whose visibility excludes the model", () => {
    expect(isAppOnlyMcpTool({ ui: { visibility: ["app"] } })).toBe(true);
    expect(isAppOnlyMcpTool({ ui: { visibility: [] } })).toBe(true);
    expect(isAppOnlyMcpTool({ ui: { visibility: ["wat"] } })).toBe(true);
  });

  it("keeps model-visible and undeclared tools", () => {
    expect(isAppOnlyMcpTool({ ui: { visibility: ["model", "app"] } })).toBe(false);
    expect(isAppOnlyMcpTool({ ui: { resourceUri: "ui://server/app.html" } })).toBe(false);
    expect(isAppOnlyMcpTool(undefined)).toBe(false);
  });
});

describe("parseMcpAppResource", () => {
  const htmlEntry = {
    uri: "ui://server/app.html",
    mimeType: "text/html;profile=mcp-app",
    text: "<!doctype html><html><body>app</body></html>",
  };

  it("extracts the html document with csp and permissions metadata", () => {
    const resource = parseMcpAppResource({
      contents: [
        {
          ...htmlEntry,
          _meta: {
            ui: {
              csp: { connectDomains: ["https://esm.sh"], resourceDomains: ["https://esm.sh"] },
              permissions: { clipboardWrite: {} },
              prefersBorder: true,
            },
          },
        },
      ],
    });
    expect(resource).toEqual({
      uri: "ui://server/app.html",
      mimeType: "text/html;profile=mcp-app",
      html: htmlEntry.text,
      csp: { connectDomains: ["https://esm.sh"], resourceDomains: ["https://esm.sh"] },
      permissions: ["clipboardWrite"],
      prefersBorder: true,
    });
  });

  it("decodes base64 blob content", () => {
    const resource = parseMcpAppResource({
      contents: [
        {
          uri: "ui://server/app.html",
          mimeType: "text/html; profile=mcp-app",
          blob: Buffer.from("<html>blob app</html>", "utf8").toString("base64"),
        },
      ],
    });
    expect(resource?.html).toBe("<html>blob app</html>");
  });

  it("rejects malformed base64 blob content", () => {
    expect(
      parseMcpAppResource({
        contents: [
          {
            uri: "ui://server/app.html",
            mimeType: "text/html;profile=mcp-app",
            blob: "not base64!",
          },
        ],
      }),
    ).toBe(undefined);
  });

  it("rejects oversized base64 blobs before decoding", () => {
    const oversizedBlob = "A".repeat(Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4 + 1);
    const bufferFromSpy = vi.spyOn(Buffer, "from");

    try {
      expect(
        parseMcpAppResource({
          contents: [
            {
              uri: "ui://server/app.html",
              mimeType: "text/html;profile=mcp-app",
              blob: oversizedBlob,
            },
          ],
        }),
      ).toBe(undefined);
      expect(bufferFromSpy).not.toHaveBeenCalledWith(oversizedBlob, "base64");
    } finally {
      bufferFromSpy.mockRestore();
    }
  });

  it("skips non-app MIME types", () => {
    expect(
      parseMcpAppResource({
        contents: [{ uri: "ui://server/app.html", mimeType: "text/html", text: "<html></html>" }],
      }),
    ).toBe(undefined);
  });

  it("skips oversized documents", () => {
    expect(
      parseMcpAppResource({
        contents: [{ ...htmlEntry, text: "x".repeat(MCP_APP_MAX_HTML_BYTES + 1) }],
      }),
    ).toBe(undefined);
  });

  it("returns undefined for malformed results", () => {
    expect(parseMcpAppResource(undefined)).toBe(undefined);
    expect(parseMcpAppResource({})).toBe(undefined);
    expect(parseMcpAppResource({ contents: "nope" })).toBe(undefined);
  });
});
