import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ENOENT_ERROR_MESSAGE = "ENOENT";

function createEnoentError(): Error {
  return new Error(ENOENT_ERROR_MESSAGE);
}

function rejectWithEnoent(): never {
  throw createEnoentError();
}

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(rejectWithEnoent),
}));

import {
  getWebAppBundleMissingText,
  getWebAppForbiddenText,
  hasPathTraversalAttempt,
  inferContentType,
  isPathWithinRoot,
  registerWebAppHttpRoute,
} from "./register.js";

const mockedReadFile = vi.mocked(readFile);
const MISSING_ROUTE_ERROR_PREFIX = "Missing";
const MISSING_ROUTE_PATH = "/missing";
const RESPONSE_HEADER_CONTENT_TYPE = "Content-Type";
const HEADER_CONTENT_TYPE = "content-type";
const CONTENT_TYPE_APPLICATION_JAVASCRIPT_UTF8 = "application/javascript; charset=utf-8";
const CONTENT_TYPE_APPLICATION_JSON_UTF8 = "application/json; charset=utf-8";
const CONTENT_TYPE_APPLICATION_OCTET_STREAM = "application/octet-stream";
const CONTENT_TYPE_IMAGE_JPEG = "image/jpeg";
const CONTENT_TYPE_IMAGE_PNG = "image/png";
const CONTENT_TYPE_IMAGE_SVG_XML = "image/svg+xml";
const CONTENT_TYPE_IMAGE_WEBP = "image/webp";
const CONTENT_TYPE_IMAGE_X_ICON = "image/x-icon";
const CONTENT_TYPE_TEXT_CSS_UTF8 = "text/css; charset=utf-8";
const CONTENT_TYPE_TEXT_HTML_UTF8 = "text/html; charset=utf-8";
const CONTENT_TYPE_TEXT_PLAIN_UTF8 = "text/plain; charset=utf-8";
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const SUPERCLAW_ASSET_APP_CSS_PATH = "/superclaw/assets/app.css";
const SUPERCLAW_ASSET_BLOB_BINX_PATH = "/superclaw/assets/blob.binx";
const SUPERCLAW_ASSET_COVER_WEBP_PATH = "/superclaw/assets/cover.webp";
const SUPERCLAW_ASSET_LOGO_PNG_PATH = "/superclaw/assets/logo.png";
const SUPERCLAW_ASSET_LOGO_SVG_PATH = "/superclaw/assets/logo.svg";
const SUPERCLAW_ASSET_MAIN_JS_PATH = "/superclaw/assets/main.js";
const SUPERCLAW_ASSET_META_JSON_PATH = "/superclaw/assets/meta.json";
const SUPERCLAW_ASSET_RATIO_QUAD_PERCENT_PNG_PATH = "/superclaw/assets/ratio%25252525.png";
const SUPERCLAW_ASSET_RATIO_QUINT_PERCENT_PNG_PATH = "/superclaw/assets/ratio%2525252525.png";
const SUPERCLAW_ENCODED_BACKSLASH_TRAVERSAL_PATH = "/superclaw/..%5c..%5coutside.txt";
const SUPERCLAW_DOUBLE_ENCODED_BACKSLASH_TRAVERSAL_PATH = "/superclaw/%252e%252e%255coutside.txt";
const SUPERCLAW_DOUBLE_ENCODED_TRAVERSAL_PATH = "/superclaw/%252e%252e%252foutside.txt";
const SUPERCLAW_ENCODED_TRAVERSAL_PATH = "/superclaw/..%2f..%2foutside.txt";
const SUPERCLAW_QUINTUPLE_ENCODED_BACKSLASH_TRAVERSAL_PATH =
  "/superclaw/%252525252e%252525252e%252525255coutside.txt";
const SUPERCLAW_QUINTUPLE_ENCODED_TRAVERSAL_PATH =
  "/superclaw/%252525252e%252525252e%252525252foutside.txt";
const SUPERCLAW_TRIPLE_ENCODED_BACKSLASH_TRAVERSAL_PATH =
  "/superclaw/%25252e%25252e%25255coutside.txt";
const SUPERCLAW_TRIPLE_ENCODED_TRAVERSAL_PATH = "/superclaw/%25252e%25252e%25252foutside.txt";
const SUPERCLAW_INVALID_HEX_ENCODING_PATH = "/superclaw/assets/%2G.png";
const SUPERCLAW_STANDALONE_PERCENT_ENCODING_PATH = "/superclaw/assets/percent%.png";
const SUPERCLAW_FAVICON_ICO_PATH = "/superclaw/favicon.ico";
const SUPERCLAW_INDEX_PATH = "/superclaw/index.html";
const SUPERCLAW_MALFORMED_ENCODING_PATH = "/superclaw/%E0%A4%A";
const SUPERCLAW_ROUTE_PATH = "/superclaw";
const SUPERCLAW_SPA_DASHBOARD_PATH = "/superclaw/app/dashboard";
const SUPERCLAW_SPA_DOUBLE_SLASH_PATH = "/superclaw//app";
const SUPERCLAW_SPA_QUERY_HASH_PATH = "/superclaw/app?x=1#y";
const SUPERCLAW_TRAILING_SLASH_PATH = "/superclaw/";

const APP_CSS_SAMPLE_TEXT = "body{color:#fff;}";
const HTML_DEFAULT_URL_INDEX_TEXT = "<html>default-url-index</html>";
const HTML_DOUBLE_SLASH_INDEX_TEXT = "<html>double-slash-index</html>";
const HTML_NOSLASH_INDEX_TEXT = "<html>noslash-index</html>";
const HTML_OK_TEXT = "<html>ok</html>";
const HTML_QUERY_HASH_INDEX_TEXT = "<html>query-hash-index</html>";
const HTML_SLASH_INDEX_TEXT = "<html>slash-index</html>";
const HTML_SPA_TEXT = "<html>spa</html>";
const MAIN_JS_SAMPLE_TEXT = "console.log('ok');";
const META_JSON_SAMPLE_TEXT = '{"ok":true}';
const RAW_BYTES_TEXT = "raw-bytes";
const SVG_SAMPLE_TEXT = "<svg></svg>";
const WEBP_HEADER_TEXT = "RIFFWEBP";

const ICO_HEADER_BYTES = [0x00, 0x00, 0x01, 0x00] as const;
const JPEG_FILE_NAMES = ["photo.jpg", "photo.jpeg"] as const;
const JPEG_HEADER_BYTES = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE_BYTES = [0x89, 0x50, 0x4e, 0x47] as const;

describe("automation register webapp bundle fallback", () => {
  type TestResponse = {
    statusCode: number;
    setHeader: (key: string, value: string) => void;
    end: (value: unknown) => void;
  };

  type TestRoute = {
    path: string;
    handler: (req: { url?: string }, res: TestResponse) => Promise<boolean>;
  };

  type RegisterWebAppApi = Pick<Parameters<typeof registerWebAppHttpRoute>[0], "registerHttpRoute">;

  type ResponseHarness = {
    response: TestResponse;
    headers: Map<string, string>;
    getBody: () => string;
  };

  type RouteInvocationResult = ResponseHarness & {
    handled: boolean;
  };

  type RouteResponseSetup = ResponseHarness & {
    route: TestRoute;
  };

  // Helpers: route.
  function buildMissingRouteErrorMessage(routePath: string): string {
    return `${MISSING_ROUTE_ERROR_PREFIX} ${routePath} route`;
  }

  function buildSuperclawAssetPath(fileName: string): string {
    return `/superclaw/assets/${fileName}`;
  }

  function createSuperclawRoute(): TestRoute {
    const registeredRoutes: TestRoute[] = [];
    const api: RegisterWebAppApi = {
      registerHttpRoute: (route: TestRoute) => {
        registeredRoutes.push(route);
      },
    };
    registerWebAppHttpRoute(unsafeCastRegisterWebAppApi(api));
    return findRouteByPath(registeredRoutes, SUPERCLAW_ROUTE_PATH);
  }

  function findRouteByPath(routes: TestRoute[], routePath: string): TestRoute {
    const route = routes.find((item) => item.path === routePath);
    if (!route) {
      throw new Error(buildMissingRouteErrorMessage(routePath));
    }
    return route;
  }

  // Helpers: route cast (test-only).
  function unsafeCastRegisterWebAppApi(
    api: RegisterWebAppApi,
  ): Parameters<typeof registerWebAppHttpRoute>[0] {
    return api as Parameters<typeof registerWebAppHttpRoute>[0];
  }

  // Helpers: response.
  function createResponseHarness(): ResponseHarness {
    let body = "";
    const headers = new Map<string, string>();
    const response: TestResponse = {
      statusCode: 0,
      setHeader: (key: string, value: string) => {
        headers.set(key.toLowerCase(), value);
      },
      end: (value: unknown) => {
        if (value == null) {
          body = "";
        } else if (Buffer.isBuffer(value)) {
          body = value.toString("utf8");
        } else if (typeof value === "string") {
          body = value;
        } else if (
          typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint"
        ) {
          body = String(value);
        } else {
          body = JSON.stringify(value);
        }
      },
    };
    return {
      response,
      headers,
      getBody: () => body,
    };
  }

  function createRouteResponseSetup(): RouteResponseSetup {
    const route = createSuperclawRoute();
    const { response, headers, getBody } = createResponseHarness();
    return { route, response, headers, getBody };
  }

  function writeResponseText(response: TestResponse, contentType: string, text: string): void {
    response.setHeader(RESPONSE_HEADER_CONTENT_TYPE, contentType);
    response.end(text);
  }

  // Helpers: assertions.
  // Body/text assertions.
  // Exact body equality assertion.
  function expectBody(getBody: () => string, expected: string): void {
    expect(getBody()).toBe(expected);
  }

  // Body substring assertion.
  function expectBodyContains(getBody: () => string, expectedPart: string): void {
    expect(getBody()).toContain(expectedPart);
  }

  // Nonempty body assertion.
  function expectBodyNotEmpty(getBody: () => string): void {
    expect(getBody()).not.toBe("");
  }

  // Text contains each expected segment assertion.
  function expectTextIncludesAll(text: string, parts: readonly string[]): void {
    for (const part of parts) {
      expect(text).toContain(part);
    }
  }

  // Content-Type assertions.
  // Header Content-Type equality assertion.
  function expectContentType(headers: Map<string, string>, expected: string): void {
    expect(headers.get(HEADER_CONTENT_TYPE)).toBe(expected);
  }

  // File-name to Content-Type inference assertion.
  function expectInferredContentType(fileName: string, expected: string): void {
    expect(inferContentType(fileName)).toBe(expected);
  }

  // Helpers: route lookup assertions.
  // Use this helper only when the expected error message differs from the default missing-route text.
  // Route lookup exact expected error assertion.
  function expectFindRouteThrows(
    routes: TestRoute[],
    routePath: string,
    expectedMessage: string,
  ): void {
    expect(() => findRouteByPath(routes, routePath)).toThrow(expectedMessage);
  }

  // Use this helper for the default missing-route error text.
  // Default missing-route message assertion.
  function expectMissingRouteError(routes: TestRoute[], routePath: string): void {
    expectFindRouteThrows(routes, routePath, buildMissingRouteErrorMessage(routePath));
  }

  // Route lookup exact success assertion.
  function expectFoundRoute(
    routes: TestRoute[],
    routePath: string,
    expectedRoute: TestRoute,
  ): void {
    expect(findRouteByPath(routes, routePath)).toBe(expectedRoute);
  }

  // Helpers: route metadata assertions.
  // Route path exact match assertion.
  function expectRoutePath(route: TestRoute, expectedPath: string): void {
    expect(route.path).toBe(expectedPath);
  }

  // Route handler is function assertion.
  function expectRouteHandlerFunction(route: TestRoute): void {
    expect(typeof route.handler).toBe("function");
  }

  // Route metadata assertions for one resolved route instance.
  function expectRouteMetadata(route: TestRoute, expectedPath: string): void {
    expectRoutePath(route, expectedPath);
    expectRouteHandlerFunction(route);
  }

  // Composite assertion for route lookup and route metadata checks.
  function expectResolvedRouteMetadata(
    routes: TestRoute[],
    routePath: string,
    expectedRoute: TestRoute,
  ): void {
    expectFoundRoute(routes, routePath, expectedRoute);
    expectRouteMetadata(expectedRoute, routePath);
  }

  function expectIsTrue(value: boolean): void {
    expect(value).toBe(true);
  }

  function expectIsFalse(value: boolean): void {
    expect(value).toBe(false);
  }

  function expectStatusCode(response: TestResponse, expected: number): void {
    expect(response.statusCode).toBe(expected);
  }

  function expectHandledWithStatus(
    handled: boolean,
    response: TestResponse,
    expectedStatusCode: number,
  ): void {
    expectIsTrue(handled);
    expectStatusCode(response, expectedStatusCode);
  }

  // Helpers: route invocation.
  async function invokeRouteForUrl(requestUrl?: string): Promise<RouteInvocationResult> {
    const { route, response, headers, getBody } = createRouteResponseSetup();
    const request = requestUrl === undefined ? {} : { url: requestUrl };
    const handled = await route.handler(request, response);
    return { handled, response, headers, getBody };
  }

  async function expectForbiddenPayloadForUrl(requestUrl: string): Promise<void> {
    const { handled, response, headers, getBody } = await invokeRouteForUrl(requestUrl);
    expectHandledWithStatus(handled, response, HTTP_STATUS_FORBIDDEN);
    expectContentType(headers, CONTENT_TYPE_TEXT_PLAIN_UTF8);
    expectBody(getBody, getWebAppForbiddenText());
  }

  function expectReadFileCalledTimes(expected: number): void {
    expect(mockedReadFile).toHaveBeenCalledTimes(expected);
  }

  // Lifecycle hooks
  beforeEach(() => {
    mockedReadFile.mockReset();
    mockedReadFile.mockImplementation(rejectWithEnoent);
  });

  // Helpers: mocks.
  function mockReadFallbackToIndex(indexHtml: string): void {
    mockedReadFile.mockRejectedValueOnce(createEnoentError());
    mockReadResolved(indexHtml);
  }

  function mockReadResolved(content: string | ReadonlyArray<number>): void {
    mockedReadFile.mockResolvedValueOnce(Buffer.from(content));
  }

  it("returns fixed zh-tw forbidden format", () => {
    const text = getWebAppForbiddenText();
    expectTextIncludesAll(text, [
      "回覆狀態：FAILED",
      "error_code=WEBAPP_PATH_FORBIDDEN",
      "next_action=CHECK_WEBAPP_PATH",
      "detail=",
    ]);
  });

  it("returns fixed zh-tw failure format", () => {
    const text = getWebAppBundleMissingText();
    expectTextIncludesAll(text, [
      "回覆狀態：FAILED",
      "error_code=WEBAPP_BUNDLE_MISSING",
      "next_action=BUILD_WEBAPP",
      "detail=",
    ]);
  });

  it("path guard correctly allows in-root and blocks out-of-root", () => {
    const root = path.resolve("virtual-root");
    const inside = path.join(root, "assets", "index.html");
    const outside = path.resolve(root, "..", "outside.txt");
    const siblingPrefixTrap = path.resolve(`${root}-evil`, "index.html");

    expectIsTrue(isPathWithinRoot(root, root));
    expectIsTrue(isPathWithinRoot(root, inside));
    expectIsFalse(isPathWithinRoot(root, outside));
    expectIsFalse(isPathWithinRoot(root, siblingPrefixTrap));
  });

  it("detects path traversal attempts including encoded variants", () => {
    expectIsFalse(hasPathTraversalAttempt("assets/logo.png"));
    expectIsTrue(hasPathTraversalAttempt("../outside.txt"));
    expectIsTrue(hasPathTraversalAttempt("..%2f..%2foutside.txt"));
    expectIsTrue(hasPathTraversalAttempt("%2e%2e/%2e%2e/outside.txt"));
    expectIsTrue(hasPathTraversalAttempt("%252e%252e%252foutside.txt"));
    expectIsTrue(hasPathTraversalAttempt("%25252e%25252e%25252foutside.txt"));
    expectIsTrue(hasPathTraversalAttempt("%252525252e%252525252e%252525252foutside.txt"));
    expectIsTrue(hasPathTraversalAttempt("%252e%252e%255coutside.txt"));
    expectIsTrue(hasPathTraversalAttempt("%25252e%25252e%25255coutside.txt"));
    expectIsTrue(hasPathTraversalAttempt("%252525252e%252525252e%252525255coutside.txt"));
    expectIsFalse(hasPathTraversalAttempt("assets/ratio%2525.png"));
    expectIsTrue(hasPathTraversalAttempt("..%5c..%5coutside.txt"));
    expectIsTrue(hasPathTraversalAttempt("%E0%A4%A"));
  });

  it("enforces decode-budget fail-closed policy for unresolved encoded octets", () => {
    expectIsFalse(hasPathTraversalAttempt("assets/ratio%25252525.png"));
    expectIsTrue(hasPathTraversalAttempt("assets/ratio%2525252525.png"));
  });

  it("infers stable content-type for known and unknown extensions", () => {
    expectInferredContentType("index.html", CONTENT_TYPE_TEXT_HTML_UTF8);
    expectInferredContentType("bundle.js", CONTENT_TYPE_APPLICATION_JAVASCRIPT_UTF8);
    expectInferredContentType("archive.unknownext", CONTENT_TYPE_APPLICATION_OCTET_STREAM);
  });

  it("findRouteByPath throws fixed error when route is missing", () => {
    expectMissingRouteError([], MISSING_ROUTE_PATH);
  });

  it("findRouteByPath returns matched route when path exists", () => {
    const route: TestRoute = {
      path: SUPERCLAW_ROUTE_PATH,
      handler: async (_req: { url?: string }, _res: TestResponse) => true,
    };
    expectResolvedRouteMetadata([route], SUPERCLAW_ROUTE_PATH, route);
  });

  it("helper builds superclaw route and captures response payload", () => {
    const { route, response, headers, getBody } = createRouteResponseSetup();
    expectRouteMetadata(route, SUPERCLAW_ROUTE_PATH);

    writeResponseText(response, CONTENT_TYPE_TEXT_PLAIN_UTF8, "ok");

    expectContentType(headers, CONTENT_TYPE_TEXT_PLAIN_UTF8);
    expectBody(getBody, "ok");
  });

  it("returns fixed bundle-missing payload when route file is absent", async () => {
    const { handled, response, headers, getBody } = await invokeRouteForUrl(SUPERCLAW_INDEX_PATH);
    expectHandledWithStatus(handled, response, HTTP_STATUS_SERVICE_UNAVAILABLE);
    expectContentType(headers, CONTENT_TYPE_TEXT_PLAIN_UTF8);
    expectBody(getBody, getWebAppBundleMissingText());
  });

  it("returns html content-type when index file exists", async () => {
    mockReadResolved(HTML_OK_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(SUPERCLAW_INDEX_PATH);
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_TEXT_HTML_UTF8);
    expectBody(getBody, HTML_OK_TEXT);
  });

  it("falls back to index.html for SPA route and returns html content-type", async () => {
    mockReadFallbackToIndex(HTML_SPA_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_SPA_DASHBOARD_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_TEXT_HTML_UTF8);
    expectBody(getBody, HTML_SPA_TEXT);
    expectReadFileCalledTimes(2);
  });

  it("returns javascript content-type when js file exists", async () => {
    mockReadResolved(MAIN_JS_SAMPLE_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_ASSET_MAIN_JS_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_APPLICATION_JAVASCRIPT_UTF8);
    expectBody(getBody, MAIN_JS_SAMPLE_TEXT);
  });

  it("returns css content-type when css file exists", async () => {
    mockReadResolved(APP_CSS_SAMPLE_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_ASSET_APP_CSS_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_TEXT_CSS_UTF8);
    expectBody(getBody, APP_CSS_SAMPLE_TEXT);
  });

  it("returns json content-type when json file exists", async () => {
    mockReadResolved(META_JSON_SAMPLE_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_ASSET_META_JSON_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_APPLICATION_JSON_UTF8);
    expectBody(getBody, META_JSON_SAMPLE_TEXT);
  });

  it("returns svg content-type when svg file exists", async () => {
    mockReadResolved(SVG_SAMPLE_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_ASSET_LOGO_SVG_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_IMAGE_SVG_XML);
    expectBody(getBody, SVG_SAMPLE_TEXT);
  });

  it("returns png content-type when png file exists", async () => {
    mockReadResolved(PNG_SIGNATURE_BYTES);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_ASSET_LOGO_PNG_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_IMAGE_PNG);
    expectBodyContains(getBody, "PNG");
  });

  it("allows high-encoded non-traversal asset path within decode budget", async () => {
    mockReadResolved(PNG_SIGNATURE_BYTES);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_ASSET_RATIO_QUAD_PERCENT_PNG_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_IMAGE_PNG);
    expectBodyContains(getBody, "PNG");
  });

  it("returns ico content-type when icon file exists", async () => {
    mockReadResolved(ICO_HEADER_BYTES);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_FAVICON_ICO_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_IMAGE_X_ICON);
    expectBodyNotEmpty(getBody);
  });

  it("returns webp content-type when webp file exists", async () => {
    mockReadResolved(WEBP_HEADER_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_ASSET_COVER_WEBP_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_IMAGE_WEBP);
    expectBodyContains(getBody, "WEBP");
  });

  it("returns jpeg content-type for jpg and jpeg files", async () => {
    for (const fileName of JPEG_FILE_NAMES) {
      mockReadResolved(JPEG_HEADER_BYTES);
      const { handled, response, headers, getBody } = await invokeRouteForUrl(
        buildSuperclawAssetPath(fileName),
      );
      expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
      expectContentType(headers, CONTENT_TYPE_IMAGE_JPEG);
      expectBodyNotEmpty(getBody);
    }
  });

  it("returns octet-stream content-type for unknown extension files", async () => {
    mockReadResolved(RAW_BYTES_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_ASSET_BLOB_BINX_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_APPLICATION_OCTET_STREAM);
    expectBody(getBody, RAW_BYTES_TEXT);
  });

  it("falls back to index.html when path ends with slash", async () => {
    mockReadResolved(HTML_SLASH_INDEX_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_TRAILING_SLASH_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_TEXT_HTML_UTF8);
    expectBody(getBody, HTML_SLASH_INDEX_TEXT);
  });

  it("falls back to index.html when route has no trailing slash", async () => {
    mockReadResolved(HTML_NOSLASH_INDEX_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(SUPERCLAW_ROUTE_PATH);
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_TEXT_HTML_UTF8);
    expectBody(getBody, HTML_NOSLASH_INDEX_TEXT);
  });

  it("falls back to index.html when req.url is undefined", async () => {
    mockReadResolved(HTML_DEFAULT_URL_INDEX_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl();
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_TEXT_HTML_UTF8);
    expectBody(getBody, HTML_DEFAULT_URL_INDEX_TEXT);
  });

  it("returns forbidden payload when encoded traversal is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_ENCODED_TRAVERSAL_PATH);
  });

  it("returns forbidden payload when double-encoded traversal is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_DOUBLE_ENCODED_TRAVERSAL_PATH);
  });

  it("returns forbidden payload when triple-encoded traversal is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_TRIPLE_ENCODED_TRAVERSAL_PATH);
  });

  it("returns forbidden payload when quintuple-encoded traversal is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_QUINTUPLE_ENCODED_TRAVERSAL_PATH);
  });

  it("returns forbidden payload when double-encoded backslash traversal is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_DOUBLE_ENCODED_BACKSLASH_TRAVERSAL_PATH);
  });

  it("returns forbidden payload when triple-encoded backslash traversal is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_TRIPLE_ENCODED_BACKSLASH_TRAVERSAL_PATH);
  });

  it("returns forbidden payload when quintuple-encoded backslash traversal is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_QUINTUPLE_ENCODED_BACKSLASH_TRAVERSAL_PATH);
  });

  it("returns forbidden payload when encoded backslash traversal is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_ENCODED_BACKSLASH_TRAVERSAL_PATH);
  });

  it("returns forbidden payload when malformed encoding is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_MALFORMED_ENCODING_PATH);
  });

  it("returns forbidden payload when invalid hex encoding is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_INVALID_HEX_ENCODING_PATH);
  });

  it("returns forbidden payload when standalone percent encoding is detected", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_STANDALONE_PERCENT_ENCODING_PATH);
  });

  it("returns forbidden payload when high-encoded non-traversal asset path exceeds decode budget", async () => {
    await expectForbiddenPayloadForUrl(SUPERCLAW_ASSET_RATIO_QUINT_PERCENT_PNG_PATH);
  });

  it("falls back to index.html when query/hash exists", async () => {
    mockReadFallbackToIndex(HTML_QUERY_HASH_INDEX_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_SPA_QUERY_HASH_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_TEXT_HTML_UTF8);
    expectBody(getBody, HTML_QUERY_HASH_INDEX_TEXT);
    expectReadFileCalledTimes(2);
  });

  it("falls back to index.html when path contains double slash", async () => {
    mockReadFallbackToIndex(HTML_DOUBLE_SLASH_INDEX_TEXT);
    const { handled, response, headers, getBody } = await invokeRouteForUrl(
      SUPERCLAW_SPA_DOUBLE_SLASH_PATH,
    );
    expectHandledWithStatus(handled, response, HTTP_STATUS_OK);
    expectContentType(headers, CONTENT_TYPE_TEXT_HTML_UTF8);
    expectBody(getBody, HTML_DOUBLE_SLASH_INDEX_TEXT);
    expectReadFileCalledTimes(2);
  });
});
