import { Type } from "@sinclair/typebox";
import {
  ToolInputError,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { stringEnum } from "openclaw/plugin-sdk/core";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import {
  readResponseText,
  withTrustedWebToolsEndpoint,
} from "openclaw/plugin-sdk/provider-web-search";
import { ensureBrightDataBrowserZoneExists } from "./brightdata-client.js";
import {
  DEFAULT_BRIGHTDATA_BASE_URL,
  resolveBrightDataApiToken,
  resolveBrightDataBaseUrl,
  resolveBrightDataBrowserZone,
  resolveBrightDataBrowserTimeoutSeconds,
} from "./config.js";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 30_000;
const PAGE_METADATA_RETRY_DELAY_MS = 250;
const PAGE_METADATA_RETRY_ATTEMPTS = 3;
const PAGE_METADATA_WAIT_TIMEOUT_MS = 5_000;

type PlaywrightModuleLike = {
  chromium: {
    connectOverCDP(endpoint: string): Promise<BrowserLike>;
  };
};

type BrowserLike = {
  contexts(): BrowserContextLike[];
  newContext(): Promise<BrowserContextLike>;
  close(): Promise<void>;
  on?(event: "disconnected", handler: () => void): void;
};

type BrowserContextLike = {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
};

type BrowserRequestLike = {
  method(): string;
  url(): string;
};

type BrowserResponseLike = {
  status(): number;
  statusText(): string;
  request(): BrowserRequestLike;
};

type LocatorLike = {
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  scrollIntoViewIfNeeded(): Promise<void>;
  waitFor(opts?: { timeout?: number }): Promise<void>;
  setChecked(value: boolean): Promise<void>;
  selectOption(value: { label: string }): Promise<void>;
  first?(): LocatorLike;
};

type SnapshotForAIPage = PageLike & {
  _snapshotForAI?: (options?: { timeout?: number; track?: string }) => Promise<{ full?: string }>;
};

type PageLike = {
  goto(
    url: string,
    opts?: { timeout?: number; waitUntil?: "domcontentloaded" | "load" | "networkidle" },
  ): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  goBack(): Promise<unknown>;
  goForward(): Promise<unknown>;
  locator(selector: string): LocatorLike;
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
  content(): Promise<string>;
  $eval(selector: string, fn: (element: Element) => unknown): Promise<unknown>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  waitForLoadState?(
    state?: "domcontentloaded" | "load" | "networkidle",
    opts?: { timeout?: number },
  ): Promise<unknown>;
  waitForTimeout?(timeout: number): Promise<unknown>;
  on?(event: "request", handler: (request: BrowserRequestLike) => void): void;
  on?(event: "response", handler: (response: BrowserResponseLike) => void): void;
  on?(event: "close", handler: () => void): void;
};

type BrowserFieldType = "textbox" | "checkbox" | "radio" | "combobox" | "slider";

type BrowserFormField = {
  name: string;
  ref: string;
  type: BrowserFieldType;
  value: string;
};

type BrowserDomElement = {
  ref: string;
  role?: string;
  name?: string;
  url?: string;
};

const INTERACTIVE_ARIA_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "tab",
  "menuitem",
  "option",
]);

const BrowserNavigateSchema = Type.Object(
  {
    url: Type.String({ description: "The URL to navigate to." }),
    country: Type.Optional(
      Type.String({
        description:
          'Optional 2-letter ISO country code to route the browser session, for example "US" or "GB".',
        minLength: 2,
        maxLength: 2,
      }),
    ),
  },
  { additionalProperties: false },
);

const BrowserSnapshotSchema = Type.Object(
  {
    filtered: Type.Optional(
      Type.Boolean({
        description:
          "Whether to apply filtering/compaction. Set to true to get a compacted interactive-element snapshot.",
      }),
    ),
  },
  { additionalProperties: false },
);

const BrowserRefActionSchema = Type.Object(
  {
    ref: Type.String({
      description: 'The ref attribute from the page snapshot, for example "23".',
    }),
    element: Type.String({ description: "Description of the element for context." }),
  },
  { additionalProperties: false },
);

const BrowserTypeSchema = Type.Object(
  {
    ref: Type.String({
      description: 'The ref attribute from the page snapshot, for example "23".',
    }),
    element: Type.String({ description: "Description of the element being typed into." }),
    text: Type.String({ description: "Text to type." }),
    submit: Type.Optional(
      Type.Boolean({
        description: "Whether to submit the form after typing by pressing Enter.",
      }),
    ),
  },
  { additionalProperties: false },
);

const BrowserScreenshotSchema = Type.Object(
  {
    full_page: Type.Optional(
      Type.Boolean({
        description:
          "Whether to capture the full page. Avoid this unless the extra height is needed.",
      }),
    ),
  },
  { additionalProperties: false },
);

const BrowserGetHtmlSchema = Type.Object(
  {
    full_page: Type.Optional(
      Type.Boolean({
        description:
          "Whether to return the full page HTML including head and script tags. Default returns only body HTML.",
      }),
    ),
  },
  { additionalProperties: false },
);

const BrowserWaitForSchema = Type.Object(
  {
    ref: Type.String({
      description: 'The ref attribute from the page snapshot, for example "23".',
    }),
    element: Type.String({ description: "Description of the element being waited for." }),
    timeout: Type.Optional(
      Type.Number({
        description: "Maximum time to wait in milliseconds.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

const BrowserFieldSchema = Type.Object(
  {
    name: Type.String({ description: "Human-readable field name." }),
    ref: Type.String({ description: "Exact target field reference from the page snapshot." }),
    type: stringEnum(["textbox", "checkbox", "radio", "combobox", "slider"] as const, {
      description: "Type of the field.",
    }),
    value: Type.String({
      description:
        'Value to fill in the field. For checkbox use "true" or "false". For combobox use the visible option label.',
    }),
  },
  { additionalProperties: false },
);

const BrowserFillFormSchema = Type.Object(
  {
    fields: Type.Array(BrowserFieldSchema, {
      description: "Fields to fill in the form.",
      minItems: 1,
    }),
  },
  { additionalProperties: false },
);

function textResult(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(details ? { details } : {}),
  };
}

function imageResult(text: string, data: Buffer, details?: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text },
      {
        type: "image" as const,
        data: data.toString("base64"),
        mimeType: "image/png",
      },
    ],
    details: {
      mimeType: "image/png",
      ...details,
    },
  };
}

function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function readRawParam(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) {
    return params[key];
  }
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return params[snakeKey];
  }
  return undefined;
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = readRawParam(params, key);
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function readArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string } = {},
): unknown[] | undefined {
  const raw = readRawParam(params, key);
  if (Array.isArray(raw)) {
    return raw;
  }
  if (options.required) {
    throw new ToolInputError(`${options.label ?? key} required`);
  }
  return undefined;
}

function readFormFields(rawParams: Record<string, unknown>): BrowserFormField[] {
  const rawFields = readArrayParam(rawParams, "fields", { required: true });
  if (!rawFields || rawFields.length === 0) {
    throw new ToolInputError("fields required");
  }
  return rawFields.map((field, index) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new ToolInputError(`fields[${index}] must be an object`);
    }
    const params = field as Record<string, unknown>;
    const name = readStringParam(params, "name", {
      required: true,
      label: `fields[${index}].name`,
    });
    const ref = readStringParam(params, "ref", {
      required: true,
      label: `fields[${index}].ref`,
    });
    const type = readStringParam(params, "type", {
      required: true,
      label: `fields[${index}].type`,
    });
    if (
      type !== "textbox" &&
      type !== "checkbox" &&
      type !== "radio" &&
      type !== "combobox" &&
      type !== "slider"
    ) {
      throw new ToolInputError(`fields[${index}].type invalid`);
    }
    const value = readStringParam(params, "value", {
      required: true,
      label: `fields[${index}].value`,
      allowEmpty: true,
    });
    return { name, ref, type, value };
  });
}

function normalizeCountry(country: string | undefined): string | undefined {
  const trimmed = country?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[A-Za-z]{2}$/.test(trimmed)) {
    throw new ToolInputError("country must be a 2-letter ISO country code");
  }
  return trimmed.toLowerCase();
}

function resolveEndpoint(baseUrl: string, pathname: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed || DEFAULT_BRIGHTDATA_BASE_URL);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return new URL(pathname, DEFAULT_BRIGHTDATA_BASE_URL).toString();
  }
}

function appendQueryParams(
  urlRaw: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(urlRaw);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function requestBrowserApiJson(params: {
  cfg?: OpenClawConfig;
  pathname: string;
  queryParams?: Record<string, string | number | boolean | undefined>;
  errorLabel: string;
  timeoutSeconds: number;
}): Promise<unknown> {
  const apiToken = resolveBrightDataApiToken(params.cfg);
  if (!apiToken) {
    throw new Error(
      "Bright Data browser tools need a Bright Data API token. Set BRIGHTDATA_API_TOKEN in the Gateway environment, or configure plugins.entries.brightdata.config.webSearch.apiKey.",
    );
  }
  const baseUrl = resolveBrightDataBaseUrl(params.cfg);
  const endpoint = appendQueryParams(resolveEndpoint(baseUrl, params.pathname), params.queryParams);
  return await withTrustedWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: "application/json",
        },
      },
    },
    async ({ response }) => {
      const textResult = await readResponseText(response, { maxBytes: 64_000 });
      const text = typeof textResult === "string" ? textResult : textResult.text;
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          if (!response.ok) {
            throw new Error(`${params.errorLabel} failed (${response.status}): ${text}`);
          }
          throw new Error(`${params.errorLabel} returned invalid JSON.`);
        }
      }
      if (!response.ok) {
        const detail =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? ((payload as Record<string, unknown>).error ??
              (payload as Record<string, unknown>).message ??
              text)
            : text;
        const detailText =
          typeof detail === "string" && detail.trim()
            ? detail
            : (() => {
                try {
                  const serialized = JSON.stringify(detail);
                  return serialized && serialized !== "null" ? serialized : text;
                } catch {
                  return text;
                }
              })();
        throw new Error(
          `${params.errorLabel} failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${detailText || "request failed"}`,
        );
      }
      return payload;
    },
  );
}

function buildBrightDataBrowserCdpEndpoint(params: {
  customer: string;
  zone: string;
  password: string;
  country?: string;
}): string {
  const countrySuffix = params.country ? `-country-${params.country}` : "";
  return `wss://brd-customer-${params.customer}-zone-${params.zone}${countrySuffix}:${params.password}@brd.superproxy.io:9222`;
}

async function resolveBrightDataBrowserCdpEndpoint(params: {
  cfg?: OpenClawConfig;
  country?: string;
}): Promise<string> {
  const country = normalizeCountry(params.country);
  const zone = resolveBrightDataBrowserZone(params.cfg);
  const timeoutSeconds = resolveBrightDataBrowserTimeoutSeconds(params.cfg);

  const statusPayload = await requestBrowserApiJson({
    cfg: params.cfg,
    pathname: "/status",
    errorLabel: "Bright Data status",
    timeoutSeconds,
  });
  const customer =
    statusPayload &&
    typeof statusPayload === "object" &&
    !Array.isArray(statusPayload) &&
    typeof (statusPayload as Record<string, unknown>).customer === "string"
      ? ((statusPayload as Record<string, unknown>).customer as string)
      : statusPayload &&
          typeof statusPayload === "object" &&
          !Array.isArray(statusPayload) &&
          typeof (statusPayload as Record<string, unknown>).customer === "number"
        ? String((statusPayload as Record<string, unknown>).customer)
        : "";
  if (!customer) {
    throw new Error("Bright Data status returned no customer identifier.");
  }

  await ensureBrightDataBrowserZoneExists(params.cfg, timeoutSeconds);

  const passwordsPayload = await requestBrowserApiJson({
    cfg: params.cfg,
    pathname: "/zone/passwords",
    queryParams: { zone },
    errorLabel: `Bright Data browser zone password (${zone})`,
    timeoutSeconds,
  });
  const passwords =
    passwordsPayload &&
    typeof passwordsPayload === "object" &&
    !Array.isArray(passwordsPayload) &&
    Array.isArray((passwordsPayload as Record<string, unknown>).passwords)
      ? ((passwordsPayload as Record<string, unknown>).passwords as unknown[])
      : [];
  const password = passwords.find((entry) => typeof entry === "string" && entry.trim()) as
    | string
    | undefined;
  if (!password) {
    throw new Error(`Bright Data browser zone "${zone}" returned no passwords.`);
  }

  return buildBrightDataBrowserCdpEndpoint({
    customer,
    zone,
    password,
    ...(country ? { country } : {}),
  });
}

function isModuleNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Cannot find module") ||
    message.includes("Cannot find package") ||
    message.includes("ERR_MODULE_NOT_FOUND") ||
    message.includes("Failed to resolve import")
  );
}

let playwrightPromise: Promise<PlaywrightModuleLike | null> | null = null;

async function getPlaywright(): Promise<PlaywrightModuleLike | null> {
  if (!playwrightPromise) {
    playwrightPromise = import("playwright")
      .then((mod) => mod as unknown as PlaywrightModuleLike)
      .catch((error) => {
        if (isModuleNotFoundError(error)) {
          return null;
        }
        throw error;
      });
  }
  return await playwrightPromise;
}

async function requirePlaywright(): Promise<PlaywrightModuleLike> {
  const playwright = await getPlaywright();
  if (playwright) {
    return playwright;
  }
  throw new Error(
    "Playwright is not installed for the Bright Data extension. Add playwright to extensions/brightdata/package.json dependencies and reinstall the extension.",
  );
}

function filterAriaSnapshot(snapshotText: string): string {
  try {
    const lines = snapshotText.split("\n");
    const elements: BrowserDomElement[] = [];
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("-")) {
        continue;
      }
      const refMatch = trimmed.match(/\[ref=([^\]]+)\]/);
      if (!refMatch) {
        continue;
      }
      const roleMatch = trimmed.match(/^-\s+([a-zA-Z]+)/);
      if (!roleMatch) {
        continue;
      }
      const role = roleMatch[1] ?? "";
      if (!INTERACTIVE_ARIA_ROLES.has(role)) {
        continue;
      }
      const nameMatch = trimmed.match(/"([^"]*)"/);
      const urlMatch = lines[index + 1]?.match(/\/url:\s*(.+)/);
      elements.push({
        ref: refMatch[1] ?? "",
        role,
        name: nameMatch?.[1] ?? "",
        url: urlMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "",
      });
    }
    if (elements.length === 0) {
      return "No interactive elements found";
    }
    return formatDomElements(elements) ?? "No interactive elements found";
  } catch (error) {
    return `Error filtering snapshot: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function formatDomElements(elements: BrowserDomElement[]): string | null {
  if (elements.length === 0) {
    return null;
  }
  return elements
    .map((entry) => {
      const parts = [`[${entry.ref}]`, entry.role?.trim() || "unknown"];
      const rawName = entry.name?.trim() || "";
      if (rawName) {
        const name = rawName.length > 60 ? `${rawName.slice(0, 57)}...` : rawName;
        parts.push(`"${name}"`);
      }
      const rawUrl = entry.url?.trim() || "";
      if (rawUrl && !rawUrl.startsWith("#")) {
        const url = rawUrl.length > 50 ? `${rawUrl.slice(0, 47)}...` : rawUrl;
        parts.push(`-> ${url}`);
      }
      return parts.join(" ");
    })
    .join("\n");
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExecutionContextDestroyedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id")
  );
}

async function waitForPageLoadState(
  page: PageLike,
  state: "domcontentloaded" | "load" | "networkidle",
  timeout = PAGE_METADATA_WAIT_TIMEOUT_MS,
): Promise<void> {
  await page.waitForLoadState?.(state, { timeout }).catch(() => {});
}

async function waitForPageTimeout(page: PageLike, ms: number): Promise<void> {
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(ms);
    return;
  }
  await sleep(ms);
}

async function readPageMetadata(page: PageLike): Promise<{ title: string; url: string }> {
  for (let attempt = 0; attempt < PAGE_METADATA_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await waitForPageLoadState(page, "domcontentloaded");
      return {
        title: await page.title(),
        url: page.url(),
      };
    } catch (error) {
      if (!isExecutionContextDestroyedError(error) || attempt >= PAGE_METADATA_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      await waitForPageLoadState(page, "load");
      await waitForPageTimeout(page, PAGE_METADATA_RETRY_DELAY_MS);
    }
  }
  throw new Error("Failed to read page metadata.");
}

class BrightDataBrowserSession {
  private readonly cdpEndpoint: string;
  private browser: BrowserLike | null = null;
  private page: PageLike | null = null;
  private requests = new Map<BrowserRequestLike, BrowserResponseLike | null>();
  private domRefs = new Set<string>();

  constructor(cdpEndpoint: string) {
    this.cdpEndpoint = cdpEndpoint;
  }

  async getPage(): Promise<PageLike> {
    if (this.page) {
      return this.page;
    }
    const browser = await this.getBrowser();
    const existingContext = browser.contexts()[0];
    const context = existingContext ?? (await browser.newContext());
    const existingPage = context.pages()[0];
    const page = existingPage ?? (await context.newPage());

    page.on?.("request", (request) => {
      this.requests.set(request, null);
    });
    page.on?.("response", (response) => {
      this.requests.set(response.request(), response);
    });
    page.on?.("close", () => {
      if (this.page === page) {
        this.page = null;
      }
    });
    this.page = page;
    return page;
  }

  async getBrowser(): Promise<BrowserLike> {
    if (this.browser) {
      try {
        void this.browser.contexts();
        return this.browser;
      } catch {
        this.browser = null;
        this.page = null;
      }
    }
    const playwright = await requirePlaywright();
    const browser = await playwright.chromium.connectOverCDP(this.cdpEndpoint);
    browser.on?.("disconnected", () => {
      if (this.browser === browser) {
        this.browser = null;
        this.page = null;
      }
    });
    this.browser = browser;
    return browser;
  }

  async captureSnapshot(filtered: boolean): Promise<{
    url: string;
    title: string;
    ariaSnapshot: string;
    domSnapshot?: string;
  }> {
    const page = await this.getPage();
    const snapshotPage = page as SnapshotForAIPage;
    if (!snapshotPage._snapshotForAI) {
      throw new Error("Playwright _snapshotForAI is not available.");
    }
    const snapshot = await snapshotPage._snapshotForAI({
      timeout: 5_000,
      track: "response",
    });
    const fullSnapshot = String(snapshot?.full ?? "");
    if (!filtered) {
      this.domRefs.clear();
      const metadata = await readPageMetadata(page);
      return {
        url: metadata.url,
        title: metadata.title,
        ariaSnapshot: fullSnapshot,
      };
    }
    const domElements = await page.evaluate<BrowserDomElement[]>(() => {
      const selectors = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        "option",
        ".radio-item",
        "[role]",
        "[tabindex]",
        "[onclick]",
        "[data-spm-click]",
        "[data-click]",
        "[data-action]",
        "[data-spm-anchor-id]",
        "[aria-pressed]",
        "[aria-label]",
        "[aria-haspopup]",
      ];
      const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
      const elements: BrowserDomElement[] = [];
      let counter = 0;

      const collapse = (text: string | null | undefined) =>
        (text || "").replace(/\s+/g, " ").trim();

      const getLabelledBy = (element: Element) => {
        const ids = (element.getAttribute("aria-labelledby") || "").split(/\s+/);
        return ids
          .map((id) => {
            const ref = document.getElementById(id);
            return ref ? collapse(ref.innerText || ref.textContent) : "";
          })
          .filter(Boolean)
          .join(" ");
      };

      const getLabelFor = (element: Element) => {
        const id = element.id?.trim();
        if (!id) {
          return "";
        }
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        return label ? collapse(label.innerText || label.textContent) : "";
      };

      const isIntrinsic = (element: Element) => {
        const tag = element.tagName.toLowerCase();
        if (["a", "input", "button", "select", "textarea", "option"].includes(tag)) {
          return true;
        }
        const role = (element.getAttribute("role") || "").toLowerCase();
        if (["button", "link", "radio", "option", "tab", "checkbox", "menuitem"].includes(role)) {
          return true;
        }
        if (element.classList.contains("radio-item")) {
          return true;
        }
        return (
          element.hasAttribute("onclick") ||
          element.hasAttribute("data-click") ||
          element.hasAttribute("data-action") ||
          element.hasAttribute("data-spm-click") ||
          element.hasAttribute("data-spm-anchor-id")
        );
      };

      const isClickable = (element: Element) => {
        const style = window.getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.pointerEvents === "none"
        ) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) {
          return false;
        }
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        if (
          centerX < 0 ||
          centerX > window.innerWidth ||
          centerY < 0 ||
          centerY > window.innerHeight
        ) {
          return false;
        }
        const topElement = document.elementFromPoint(centerX, centerY);
        if (
          topElement &&
          (topElement === element ||
            topElement.contains(element) ||
            (element instanceof HTMLElement && element.contains(topElement)))
        ) {
          return true;
        }
        return isIntrinsic(element);
      };

      for (const element of nodes) {
        if (!isClickable(element)) {
          continue;
        }

        let name =
          collapse(element.getAttribute("aria-label")) ||
          collapse(getLabelledBy(element)) ||
          collapse(element.getAttribute("title")) ||
          collapse(element.getAttribute("alt")) ||
          collapse(element.getAttribute("placeholder")) ||
          collapse(getLabelFor(element));

        if (!name) {
          name = collapse((element as HTMLElement).innerText || element.textContent);
        }
        if (name.length > 80) {
          name = `${name.slice(0, 77)}...`;
        }

        const url = (
          (element as HTMLAnchorElement).href ||
          element.getAttribute("data-url") ||
          ""
        ).toString();
        if (!name && !url) {
          continue;
        }
        const htmlElement = element as HTMLElement & { dataset: DOMStringMap };
        if (!htmlElement.dataset.fastmcpRef) {
          htmlElement.dataset.fastmcpRef = `dom-${++counter}`;
        }
        elements.push({
          ref: htmlElement.dataset.fastmcpRef,
          role: element.getAttribute("role") || element.tagName.toLowerCase(),
          name,
          url,
        });
      }
      return elements;
    });

    this.domRefs = new Set(domElements.map((entry) => entry.ref));
    const domSnapshot = formatDomElements(domElements);
    const metadata = await readPageMetadata(page);
    return {
      url: metadata.url,
      title: metadata.title,
      ariaSnapshot: filterAriaSnapshot(fullSnapshot),
      ...(domSnapshot ? { domSnapshot } : {}),
    };
  }

  async refLocator(params: { element: string; ref: string }): Promise<LocatorLike> {
    const page = await this.getPage();
    if (this.domRefs.has(params.ref)) {
      const locator = page.locator(`[data-fastmcp-ref="${escapeAttributeValue(params.ref)}"]`);
      return typeof locator.first === "function" ? locator.first() : locator;
    }

    const snapshotPage = page as SnapshotForAIPage;
    if (!snapshotPage._snapshotForAI) {
      throw new Error("Playwright _snapshotForAI is not available.");
    }
    const snapshot = await snapshotPage._snapshotForAI({
      timeout: 5_000,
      track: "response",
    });
    const fullSnapshot = String(snapshot?.full ?? "");
    if (!fullSnapshot.includes(`[ref=${params.ref}]`)) {
      throw new Error(
        `Ref ${params.ref} not found in the current page snapshot. Capture a new snapshot first.`,
      );
    }
    return page.locator(`aria-ref=${params.ref}`);
  }

  getRequests() {
    return this.requests;
  }

  clearRequests() {
    this.requests.clear();
  }

  clearSnapshotState() {
    this.domRefs.clear();
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.requests.clear();
    this.domRefs.clear();
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

type ScopedBrowserSession = {
  country: string | null;
  session: BrightDataBrowserSession;
};

const browserSessionsByScope = new Map<string, ScopedBrowserSession>();

function resolveBrowserSessionScopeKey(context?: OpenClawPluginToolContext): string {
  const sessionId = context?.sessionId?.trim();
  if (sessionId) {
    return `session-id:${sessionId}`;
  }
  const sessionKey = context?.sessionKey?.trim();
  if (sessionKey) {
    return `session-key:${sessionKey}`;
  }
  const agentId = context?.agentId?.trim();
  if (agentId) {
    return `agent:${agentId}`;
  }
  return "global";
}

async function requireBrowserSession(params: {
  cfg?: OpenClawConfig;
  country?: string;
  context?: OpenClawPluginToolContext;
  createSession?: (cdpEndpoint: string) => BrightDataBrowserSession;
  resolveCdpEndpoint?: (params: { cfg?: OpenClawConfig; country?: string }) => Promise<string>;
}): Promise<BrightDataBrowserSession> {
  const scopeKey = resolveBrowserSessionScopeKey(params.context);
  const existing = browserSessionsByScope.get(scopeKey);
  const normalizedCountry =
    params.country !== undefined
      ? normalizeCountry(params.country)
      : (existing?.country ?? undefined);
  const resolvedCountry = normalizedCountry ?? null;
  const needsNewSession = !existing || resolvedCountry !== existing.country;
  if (needsNewSession) {
    await existing?.session.close();
    const resolveCdpEndpoint = params.resolveCdpEndpoint ?? resolveBrightDataBrowserCdpEndpoint;
    const createSession =
      params.createSession ?? ((cdpEndpoint: string) => new BrightDataBrowserSession(cdpEndpoint));
    const session = createSession(
      await resolveCdpEndpoint({
        cfg: params.cfg,
        ...(resolvedCountry ? { country: resolvedCountry } : {}),
      }),
    );
    browserSessionsByScope.set(scopeKey, {
      country: resolvedCountry,
      session,
    });
  }
  return browserSessionsByScope.get(scopeKey)!.session;
}

export const BRIGHTDATA_BROWSER_TOOL_NAMES = [
  "brightdata_browser_navigate",
  "brightdata_browser_go_back",
  "brightdata_browser_go_forward",
  "brightdata_browser_snapshot",
  "brightdata_browser_click",
  "brightdata_browser_type",
  "brightdata_browser_screenshot",
  "brightdata_browser_get_html",
  "brightdata_browser_get_text",
  "brightdata_browser_scroll",
  "brightdata_browser_scroll_to",
  "brightdata_browser_wait_for",
  "brightdata_browser_network_requests",
  "brightdata_browser_fill_form",
] as const;

export function createBrightDataBrowserTools(
  api: OpenClawPluginApi,
  context?: OpenClawPluginToolContext,
) {
  return [
    {
      name: "brightdata_browser_navigate",
      label: "Bright Data Browser Navigate",
      description: "Navigate a Bright Data scraping browser session to a new URL.",
      parameters: BrowserNavigateSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const url = readStringParam(rawParams, "url", { required: true });
        const country = readStringParam(rawParams, "country");
        const session = await requireBrowserSession({
          cfg: api.config,
          context,
          ...(country ? { country } : {}),
        });
        const page = await session.getPage();
        session.clearRequests();
        session.clearSnapshotState();
        await page.goto(url, {
          timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
        const metadata = await readPageMetadata(page);
        return textResult(
          [
            `Successfully navigated to ${url}`,
            `Title: ${metadata.title}`,
            `URL: ${metadata.url}`,
          ].join("\n"),
          {
            url: metadata.url,
            title: metadata.title,
            ...(country ? { country: normalizeCountry(country) } : {}),
          },
        );
      },
    },
    {
      name: "brightdata_browser_go_back",
      label: "Bright Data Browser Go Back",
      description: "Go back to the previous page in the Bright Data browser session.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const session = await requireBrowserSession({ cfg: api.config, context });
        const page = await session.getPage();
        session.clearRequests();
        session.clearSnapshotState();
        await page.goBack();
        const metadata = await readPageMetadata(page);
        return textResult(
          ["Successfully navigated back", `Title: ${metadata.title}`, `URL: ${metadata.url}`].join(
            "\n",
          ),
          { url: metadata.url, title: metadata.title },
        );
      },
    },
    {
      name: "brightdata_browser_go_forward",
      label: "Bright Data Browser Go Forward",
      description: "Go forward to the next page in the Bright Data browser session.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const session = await requireBrowserSession({ cfg: api.config, context });
        const page = await session.getPage();
        session.clearRequests();
        session.clearSnapshotState();
        await page.goForward();
        const metadata = await readPageMetadata(page);
        return textResult(
          [
            "Successfully navigated forward",
            `Title: ${metadata.title}`,
            `URL: ${metadata.url}`,
          ].join("\n"),
          { url: metadata.url, title: metadata.title },
        );
      },
    },
    {
      name: "brightdata_browser_snapshot",
      label: "Bright Data Browser Snapshot",
      description:
        "Capture an ARIA snapshot of the current page showing interactive elements and refs.",
      parameters: BrowserSnapshotSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const filtered = readBooleanParam(rawParams, "filtered") ?? false;
        const snapshot = await (
          await requireBrowserSession({ cfg: api.config, context })
        ).captureSnapshot(filtered);
        const lines = [
          `Page: ${snapshot.url}`,
          `Title: ${snapshot.title}`,
          "",
          "Interactive Elements:",
          snapshot.ariaSnapshot,
        ];
        if (snapshot.domSnapshot) {
          lines.push("", "DOM Interactive Elements:", snapshot.domSnapshot);
        }
        return textResult(lines.join("\n"), {
          url: snapshot.url,
          title: snapshot.title,
          filtered,
        });
      },
    },
    {
      name: "brightdata_browser_click",
      label: "Bright Data Browser Click",
      description: "Click an element using its ref from the Bright Data browser snapshot.",
      parameters: BrowserRefActionSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const ref = readStringParam(rawParams, "ref", { required: true });
        const element = readStringParam(rawParams, "element", { required: true });
        const locator = await (
          await requireBrowserSession({ cfg: api.config, context })
        ).refLocator({
          ref,
          element,
        });
        await locator.click({ timeout: 5_000 });
        return textResult(`Successfully clicked element: ${element} (ref=${ref})`, {
          ref,
          element,
        });
      },
    },
    {
      name: "brightdata_browser_type",
      label: "Bright Data Browser Type",
      description: "Type text into an element using its ref from the Bright Data browser snapshot.",
      parameters: BrowserTypeSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const ref = readStringParam(rawParams, "ref", { required: true });
        const element = readStringParam(rawParams, "element", { required: true });
        const text = readStringParam(rawParams, "text", {
          required: true,
          allowEmpty: true,
        });
        const submit = readBooleanParam(rawParams, "submit") ?? false;
        const locator = await (
          await requireBrowserSession({ cfg: api.config, context })
        ).refLocator({
          ref,
          element,
        });
        await locator.fill(text);
        if (submit) {
          await locator.press("Enter");
        }
        return textResult(
          `Successfully typed "${text}" into element: ${element} (ref=${ref})${submit ? " and submitted the form" : ""}`,
          { ref, element, text, submit },
        );
      },
    },
    {
      name: "brightdata_browser_screenshot",
      label: "Bright Data Browser Screenshot",
      description: "Take a screenshot of the current page in the Bright Data browser session.",
      parameters: BrowserScreenshotSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const fullPage = readBooleanParam(rawParams, "full_page") ?? false;
        const page = await (await requireBrowserSession({ cfg: api.config, context })).getPage();
        const buffer = await page.screenshot({ fullPage });
        return imageResult(`Browser screenshot (${fullPage ? "full page" : "viewport"})`, buffer, {
          fullPage,
          url: page.url(),
        });
      },
    },
    {
      name: "brightdata_browser_get_html",
      label: "Bright Data Browser Get HTML",
      description: "Get the HTML content of the current page.",
      parameters: BrowserGetHtmlSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const fullPage = readBooleanParam(rawParams, "full_page") ?? false;
        const page = await (await requireBrowserSession({ cfg: api.config, context })).getPage();
        const html = fullPage
          ? await page.content()
          : String((await page.$eval("body", (body) => (body as HTMLElement).innerHTML)) ?? "");
        return textResult(html, {
          url: page.url(),
          fullPage,
        });
      },
    },
    {
      name: "brightdata_browser_get_text",
      label: "Bright Data Browser Get Text",
      description: "Get the text content of the current page.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const page = await (await requireBrowserSession({ cfg: api.config, context })).getPage();
        const text = String(
          (await page.$eval("body", (body) => (body as HTMLElement).innerText)) ?? "",
        );
        return textResult(text, { url: page.url() });
      },
    },
    {
      name: "brightdata_browser_scroll",
      label: "Bright Data Browser Scroll",
      description: "Scroll to the bottom of the current page.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const page = await (await requireBrowserSession({ cfg: api.config, context })).getPage();
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        return textResult("Successfully scrolled to the bottom of the page", {
          url: page.url(),
        });
      },
    },
    {
      name: "brightdata_browser_scroll_to",
      label: "Bright Data Browser Scroll To",
      description:
        "Scroll to a specific element using its ref from the Bright Data browser snapshot.",
      parameters: BrowserRefActionSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const ref = readStringParam(rawParams, "ref", { required: true });
        const element = readStringParam(rawParams, "element", { required: true });
        const locator = await (
          await requireBrowserSession({ cfg: api.config, context })
        ).refLocator({
          ref,
          element,
        });
        await locator.scrollIntoViewIfNeeded();
        return textResult(`Successfully scrolled to element: ${element} (ref=${ref})`, {
          ref,
          element,
        });
      },
    },
    {
      name: "brightdata_browser_wait_for",
      label: "Bright Data Browser Wait For",
      description:
        "Wait for an element to be visible using its ref from the Bright Data browser snapshot.",
      parameters: BrowserWaitForSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const ref = readStringParam(rawParams, "ref", { required: true });
        const element = readStringParam(rawParams, "element", { required: true });
        const timeout =
          readNumberParam(rawParams, "timeout", {
            integer: true,
          }) ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
        const locator = await (
          await requireBrowserSession({ cfg: api.config, context })
        ).refLocator({
          ref,
          element,
        });
        await locator.waitFor({ timeout });
        return textResult(`Successfully waited for element: ${element} (ref=${ref})`, {
          ref,
          element,
          timeout,
        });
      },
    },
    {
      name: "brightdata_browser_network_requests",
      label: "Bright Data Browser Network Requests",
      description: "Get network requests recorded since the current page was loaded.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const session = await requireBrowserSession({ cfg: api.config, context });
        const requests = Array.from(session.getRequests().entries()).map(([request, response]) => {
          const parts = [`[${request.method().toUpperCase()}] ${request.url()}`];
          if (response) {
            parts.push(`=> [${response.status()}] ${response.statusText()}`);
          }
          return parts.join(" ");
        });
        if (requests.length === 0) {
          return textResult("No network requests recorded for the current page.", { count: 0 });
        }
        return textResult(
          [`Network Requests (${requests.length} total):`, "", ...requests].join("\n"),
          { count: requests.length },
        );
      },
    },
    {
      name: "brightdata_browser_fill_form",
      label: "Bright Data Browser Fill Form",
      description: "Fill multiple form fields in one operation using refs from the page snapshot.",
      parameters: BrowserFillFormSchema,
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
        const fields = readFormFields(rawParams);
        const session = await requireBrowserSession({ cfg: api.config, context });
        const results: string[] = [];

        for (const field of fields) {
          const locator = await session.refLocator({
            element: field.name,
            ref: field.ref,
          });
          if (field.type === "textbox" || field.type === "slider") {
            await locator.fill(field.value);
            results.push(`Filled ${field.name} with "${field.value}"`);
            continue;
          }
          if (field.type === "checkbox" || field.type === "radio") {
            const checked = field.value.trim().toLowerCase() === "true";
            await locator.setChecked(checked);
            results.push(`Set ${field.name} to ${checked ? "checked" : "unchecked"}`);
            continue;
          }
          await locator.selectOption({ label: field.value });
          results.push(`Selected "${field.value}" in ${field.name}`);
        }

        return textResult(`Successfully filled form:\n${results.join("\n")}`, {
          filled: fields.length,
        });
      },
    },
  ];
}

export const __testing = {
  BRIGHTDATA_BROWSER_TOOL_NAMES,
  buildBrightDataBrowserCdpEndpoint,
  filterAriaSnapshot,
  formatDomElements,
  readPageMetadata,
  requireBrowserSession,
  resolveBrowserSessionScopeKey,
  resolveBrightDataBrowserCdpEndpoint,
  resetBrowserSessions() {
    browserSessionsByScope.clear();
  },
};
