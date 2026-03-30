import { describe, it, assert } from "vitest";
import { UrlValidator } from "../src/security/url-validator.js";

describe("UrlValidator", () => {
  const validator = new UrlValidator();

  it("blocks localhost", () => {
    assert.equal(validator.isSafe("http://localhost:8080/api"), false);
  });
  it("blocks 127.0.0.1", () => {
    assert.equal(validator.isSafe("http://127.0.0.1/secret"), false);
  });
  it("blocks private 10.x.x.x", () => {
    assert.equal(validator.isSafe("http://10.0.0.1/internal"), false);
  });
  it("blocks private 192.168.x.x", () => {
    assert.equal(validator.isSafe("http://192.168.1.1/router"), false);
  });
  it("blocks private 172.16-31.x.x", () => {
    assert.equal(validator.isSafe("http://172.16.0.1/internal"), false);
  });
  it("blocks metadata endpoints", () => {
    assert.equal(validator.isSafe("http://169.254.169.254/latest/meta-data"), false);
  });
  it("blocks file:// protocol", () => {
    assert.equal(validator.isSafe("file:///etc/passwd"), false);
  });
  it("allows public HTTPS URLs", () => {
    assert.equal(validator.isSafe("https://api.shopify.com/admin/products.json"), true);
  });
  it("allows explicitly allowed domains", () => {
    const v = new UrlValidator({ allowedDomains: ["internal.corp.com"] });
    assert.equal(v.isSafe("http://internal.corp.com/api"), true);
  });
  it("returns false for malformed URLs", () => {
    assert.equal(validator.isSafe("not-a-url"), false);
  });
});
