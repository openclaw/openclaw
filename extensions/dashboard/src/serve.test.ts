import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseWidgetRequestPath,
  serveWidgetAsset,
  WIDGET_CSP,
  WIDGETS_ROUTE_PREFIX,
} from "./serve.js";
import { DashboardStore } from "./store.js";

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
};

/** Minimal ServerResponse stub capturing status, headers, and body. */
function fakeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, headers: {}, body: "", ended: false };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
      captured.ended = true;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function withApprovedWidget<T>(
  run: (ctx: { stateDir: string; store: DashboardStore; widgetDir: string }) => Promise<T>,
): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dashboard-serve-"));
  try {
    const store = new DashboardStore({ stateDir });
    const widgetDir = path.join(stateDir, "dashboard", "widgets", "revenue-chart");
    await fs.mkdir(widgetDir, { recursive: true });
    await fs.writeFile(path.join(widgetDir, "index.html"), "<!doctype html><h1>ok</h1>");
    await fs.writeFile(path.join(widgetDir, "app.js"), "console.log(1)");
    await fs.writeFile(path.join(widgetDir, "secret.mjs"), "export const x = 1");
    await store.mutate(
      (draft) => {
        draft.widgetsRegistry["revenue-chart"] = {
          status: "approved",
          createdBy: "user",
          approvedBy: "user",
          approvedAt: new Date().toISOString(),
        };
      },
      { actor: "user" },
    );
    return await run({ stateDir, store, widgetDir });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function urlFor(name: string, rest: string): string {
  return `${WIDGETS_ROUTE_PREFIX}/${name}/${rest}`;
}

describe("parseWidgetRequestPath", () => {
  it("returns null for a pathname not under the widgets prefix", () => {
    expect(parseWidgetRequestPath("/plugins/other/x/y")).toBeNull();
  });

  it("returns null when no logical path is present (name only)", () => {
    expect(parseWidgetRequestPath(`${WIDGETS_ROUTE_PREFIX}/revenue-chart`)).toBeNull();
  });

  it("rejects a name failing the charset check", () => {
    expect(parseWidgetRequestPath(`${WIDGETS_ROUTE_PREFIX}/../etc/passwd`)).toBeNull();
  });

  it("rejects an encoded traversal segment in the logical path", () => {
    expect(parseWidgetRequestPath(urlFor("revenue-chart", "%2e%2e/secret"))).toBeNull();
  });

  it("parses a valid name and logical path", () => {
    expect(parseWidgetRequestPath(urlFor("revenue-chart", "assets/app.js"))).toEqual({
      name: "revenue-chart",
      logicalPath: "assets/app.js",
    });
  });
});

describe("serveWidgetAsset security jail", () => {
  it("serves an approved widget's index.html with strict headers", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      const handled = await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "index.html") },
        res,
        { store, stateDir },
      );
      expect(handled).toBe(true);
      expect(captured.statusCode).toBe(200);
      expect(captured.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(captured.headers["content-security-policy"]).toBe(WIDGET_CSP);
      expect(captured.headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(captured.headers["x-content-type-options"]).toBe("nosniff");
      expect(captured.headers["referrer-policy"]).toBe("no-referrer");
      expect(captured.body).toContain("<h1>ok</h1>");
    });
  });

  it("serves a .js asset with the allowlisted content type + CSP + nosniff", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      await serveWidgetAsset({ method: "GET", pathname: urlFor("revenue-chart", "app.js") }, res, {
        store,
        stateDir,
      });
      expect(captured.statusCode).toBe(200);
      expect(captured.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(captured.headers["content-security-policy"]).toBe(WIDGET_CSP);
      expect(captured.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  it("returns false (not handled) for a pathname outside the route", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res } = fakeResponse();
      const handled = await serveWidgetAsset(
        { method: "GET", pathname: "/plugins/canvas/host/x" },
        res,
        { store, stateDir },
      );
      expect(handled).toBe(false);
    });
  });

  const traversalCases: Array<{ label: string; pathname: string }> = [
    { label: "dot-dot traversal", pathname: urlFor("revenue-chart", "../secret.txt") },
    { label: "encoded %2e%2e traversal", pathname: urlFor("revenue-chart", "%2e%2e/secret.txt") },
    {
      label: "absolute path",
      pathname: `${WIDGETS_ROUTE_PREFIX}/revenue-chart//etc/passwd`,
    },
    { label: "backslash traversal", pathname: urlFor("revenue-chart", "..%5csecret.txt") },
    { label: "name charset violation", pathname: `${WIDGETS_ROUTE_PREFIX}/..%2f..%2fx/index.html` },
  ];

  for (const { label, pathname } of traversalCases) {
    it(`404s on ${label}`, async () => {
      await withApprovedWidget(async ({ store, stateDir }) => {
        const { res, captured } = fakeResponse();
        await serveWidgetAsset({ method: "GET", pathname }, res, { store, stateDir });
        expect(captured.statusCode).toBe(404);
        // A 404 is still an attacker-influenced response from the widget origin,
        // so it MUST carry the same strict CSP as a 200 (invariant I1/I4).
        expect(captured.headers["content-security-policy"]).toBe(WIDGET_CSP);
        expect(captured.headers["referrer-policy"]).toBe("no-referrer");
      });
    });
  }

  it("404s (never 403) on a symlink that escapes the widget dir", async () => {
    await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
      const outsideFile = path.join(stateDir, "outside-secret.txt");
      await fs.writeFile(outsideFile, "top secret");
      await fs.symlink(outsideFile, path.join(widgetDir, "leak.txt"));
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "leak.txt") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s on a non-GET method", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const { res, captured } = fakeResponse();
        await serveWidgetAsset({ method, pathname: urlFor("revenue-chart", "index.html") }, res, {
          store,
          stateDir,
        });
        expect(captured.statusCode).toBe(404);
      }
    });
  });

  it("404s on a disallowed extension even when the file exists", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "secret.mjs") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s assets for a pending (not approved) widget", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const pendingDir = path.join(stateDir, "dashboard", "widgets", "pending-widget");
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, "index.html"), "<h1>pending</h1>");
      await store.mutate(
        (draft) => {
          draft.widgetsRegistry["pending-widget"] = { status: "pending", createdBy: "agent:x" };
        },
        { actor: "user" },
      );
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("pending-widget", "index.html") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s assets for a rejected widget", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const rejectedDir = path.join(stateDir, "dashboard", "widgets", "rejected-widget");
      await fs.mkdir(rejectedDir, { recursive: true });
      await fs.writeFile(path.join(rejectedDir, "index.html"), "<h1>rejected</h1>");
      await store.mutate(
        (draft) => {
          draft.widgetsRegistry["rejected-widget"] = { status: "rejected", createdBy: "agent:x" };
        },
        { actor: "user" },
      );
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("rejected-widget", "index.html") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s a missing file inside an approved widget dir", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "does-not-exist.css") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });
});
