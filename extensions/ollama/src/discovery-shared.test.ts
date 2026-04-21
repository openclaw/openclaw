import { describe, expect, it } from "vitest";
import { isLocalOllamaBaseUrl } from "./discovery-shared.js";

describe("isLocalOllamaBaseUrl", () => {
  describe("local (returns true)", () => {
    it.each([
      "http://localhost:11434",
      "http://127.0.0.1:11434",
      "http://0.0.0.0:11434",
      "http://[::1]:11434",
      "http://[::]:11434",
      "http://10.0.0.5:11434",
      "http://172.16.0.10:11434",
      "http://172.31.255.254:11434",
      "http://192.168.1.100:11434",
      "http://gpu-node-1:11434",
      "http://mac-studio.local:11434",
      "http://MAC-STUDIO.LOCAL:11434",
      "http://[fd00::1]:11434",
      "http://[fc00::1]:11434",
      "http://[fe80::1]:11434",
    ])("classifies %s as local", (url) => {
      expect(isLocalOllamaBaseUrl(url)).toBe(true);
    });

    it("classifies undefined baseUrl as local (ambient discovery)", () => {
      expect(isLocalOllamaBaseUrl(undefined)).toBe(true);
      expect(isLocalOllamaBaseUrl(null)).toBe(true);
    });

    it("classifies empty string baseUrl as local", () => {
      expect(isLocalOllamaBaseUrl("")).toBe(true);
    });
  });

  describe("remote (returns false)", () => {
    it.each([
      "https://ollama.com",
      "https://api.ollama.com/v1",
      "https://ollama.example.com:11434",
      "http://8.8.8.8:11434",
      "http://172.15.255.254:11434",
      "http://172.32.0.1:11434",
      "http://193.168.1.1:11434",
      "http://[2001:4860:4860::8888]:11434",
      "http://10.example.com:11434",
      "http://192.168.example.com:11434",
      "http://172.20.company.net:11434",
    ])("classifies %s as remote", (url) => {
      expect(isLocalOllamaBaseUrl(url)).toBe(false);
    });

    it("classifies unparseable URL as remote (conservative)", () => {
      expect(isLocalOllamaBaseUrl("not a url")).toBe(false);
    });
  });
});
