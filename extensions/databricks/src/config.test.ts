import { describe, expect, it } from "vitest";
import { resolveDatabricksRuntimeConfig } from "./config.js";
import { DatabricksConfigError } from "./errors.js";

describe("databricks config", () => {
  it("resolves required config and defaults", () => {
    const resolved = resolveDatabricksRuntimeConfig({
      rawConfig: {
        host: "dbc-example.cloud.databricks.com",
        token: "dapi-test-token",
        warehouseId: "abc123",
      },
      env: {},
    });

    expect(resolved.host).toBe("https://dbc-example.cloud.databricks.com");
    expect(resolved.timeoutMs).toBe(30_000);
    expect(resolved.retryCount).toBe(1);
    expect(resolved.pollingIntervalMs).toBe(1_000);
    expect(resolved.maxPollingWaitMs).toBe(30_000);
    expect(resolved.allowedCatalogs).toEqual([]);
    expect(resolved.allowedSchemas).toEqual([]);
    expect(resolved.readOnly).toBe(true);
  });

  it("uses environment fallback values", () => {
    const resolved = resolveDatabricksRuntimeConfig({
      rawConfig: {},
      env: {
        DATABRICKS_HOST: "https://dbc-env.cloud.databricks.com",
        DATABRICKS_TOKEN: "dapi-env",
        DATABRICKS_WAREHOUSE_ID: "wh-env",
      },
    });

    expect(resolved.host).toBe("https://dbc-env.cloud.databricks.com");
    expect(resolved.token).toBe("dapi-env");
    expect(resolved.warehouseId).toBe("wh-env");
  });

  it("rejects missing required fields", () => {
    expect(() =>
      resolveDatabricksRuntimeConfig({
        rawConfig: {
          host: "https://dbc-example.cloud.databricks.com",
          warehouseId: "abc123",
        },
        env: {},
      }),
    ).toThrow(DatabricksConfigError);
  });

  it("rejects readOnly=false", () => {
    expect(() =>
      resolveDatabricksRuntimeConfig({
        rawConfig: {
          host: "https://dbc-example.cloud.databricks.com",
          token: "dapi-test-token",
          warehouseId: "abc123",
          readOnly: false,
        },
        env: {},
      }),
    ).toThrow("Only readOnly=true is supported");
  });

  it("normalizes allowlists", () => {
    const resolved = resolveDatabricksRuntimeConfig({
      rawConfig: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test-token",
        warehouseId: "abc123",
        allowedCatalogs: ["Main", " analytics "],
        allowedSchemas: ["Public"],
      },
      env: {},
    });

    expect(resolved.allowedCatalogs).toEqual(["main", "analytics"]);
    expect(resolved.allowedSchemas).toEqual(["public"]);
  });
});
