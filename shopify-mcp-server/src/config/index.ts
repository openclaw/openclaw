/**
 * Configuration management for Shopify Admin MCP Server
 *
 * This module handles environment variable loading, validation,
 * and provides typed configuration objects for the application.
 */

import { config } from "dotenv";
import { SHOPIFY_API_VERSION, MCPToolConfig } from "@/types/index.js";

// Load environment variables
config();

/**
 * Shopify API configuration
 */
export interface ShopifyConfig {
  /** Shopify store domain (e.g., 'mystore.myshopify.com') */
  storeDomain: string;
  /** Shopify Admin API access token */
  accessToken: string;
  /** API version to use */
  apiVersion: string;
  /** GraphQL endpoint URL */
  graphqlEndpoint: string;
  /** REST API endpoint URL */
  restEndpoint: string;
  /** Maximum retries for failed requests */
  maxRetries: number;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Rate limiting configuration */
  rateLimiting: {
    /** Maximum requests per second */
    maxRequestsPerSecond: number;
    /** Burst allowance */
    burstAllowance: number;
    /** Whether to respect Shopify's rate limits */
    respectShopifyLimits: boolean;
  };
}

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  /** Server name */
  name: string;
  /** Server version */
  version: string;
  /** Default tool configuration */
  defaultToolConfig: MCPToolConfig;
  /** Logging configuration */
  logging: {
    /** Log level */
    level: "debug" | "info" | "warn" | "error";
    /** Whether to log GraphQL queries */
    logQueries: boolean;
    /** Whether to log API responses */
    logResponses: boolean;
    /** Whether to log performance metrics */
    logPerformance: boolean;
  };
  /** Feature flags */
  features: {
    /** Enable bulk operations */
    enableBulkOperations: boolean;
    /** Enable webhook management */
    enableWebhooks: boolean;
    /** Enable advanced analytics */
    enableAnalytics: boolean;
    /** Enable experimental features */
    enableExperimental: boolean;
  };
}

/**
 * Application configuration
 */
export interface AppConfig {
  /** Shopify configuration */
  shopify: ShopifyConfig;
  /** MCP server configuration */
  server: MCPServerConfig;
  /** Environment */
  environment: "development" | "staging" | "production";
  /** Debug mode */
  debug: boolean;
}

/**
 * Environment variable validation
 */
function validateEnvironment(): void {
  const required = ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ACCESS_TOKEN"];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\n\n` +
        "Please ensure the following environment variables are set:\n" +
        "- SHOPIFY_STORE_DOMAIN: Your Shopify store domain (e.g., mystore.myshopify.com)\n" +
        "- SHOPIFY_ACCESS_TOKEN: Your Shopify Admin API access token\n\n" +
        "Optional environment variables:\n" +
        "- SHOPIFY_API_VERSION: API version (default: 2024-04)\n" +
        "- MCP_SERVER_NAME: Server name (default: shopify-admin-mcp-server)\n" +
        "- MCP_SERVER_VERSION: Server version (default: 2.0.0)\n" +
        "- LOG_LEVEL: Logging level (default: info)\n" +
        "- DEBUG: Enable debug mode (default: false)\n" +
        "- MAX_RETRIES: Maximum request retries (default: 3)\n" +
        "- REQUEST_TIMEOUT: Request timeout in ms (default: 30000)\n",
    );
  }

  // Validate store domain format
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN!;
  if (!storeDomain.includes(".myshopify.com") && !storeDomain.includes(".shopify.com")) {
    console.warn(
      `Warning: SHOPIFY_STORE_DOMAIN "${storeDomain}" doesn't appear to be a valid Shopify domain. ` +
        "Expected format: mystore.myshopify.com",
    );
  }

  // Validate access token format (basic check)
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN!;
  if (accessToken.length < 20) {
    console.warn(
      "Warning: SHOPIFY_ACCESS_TOKEN appears to be too short. " +
        "Please ensure you're using a valid Shopify Admin API access token.",
    );
  }
}

/**
 * Create Shopify configuration from environment variables
 */
function createShopifyConfig(): ShopifyConfig {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN!;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN!;
  const apiVersion = process.env.SHOPIFY_API_VERSION || SHOPIFY_API_VERSION;

  // Ensure store domain has proper format
  const normalizedDomain = storeDomain.includes("://") ? storeDomain.split("://")[1] : storeDomain;

  return {
    storeDomain: normalizedDomain,
    accessToken,
    apiVersion,
    graphqlEndpoint: `https://${normalizedDomain}/admin/api/${apiVersion}/graphql.json`,
    restEndpoint: `https://${normalizedDomain}/admin/api/${apiVersion}`,
    maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
    timeout: parseInt(process.env.REQUEST_TIMEOUT || "30000", 10),
    rateLimiting: {
      maxRequestsPerSecond: parseInt(process.env.MAX_REQUESTS_PER_SECOND || "10", 10),
      burstAllowance: parseInt(process.env.BURST_ALLOWANCE || "40", 10),
      respectShopifyLimits: process.env.RESPECT_SHOPIFY_LIMITS !== "false",
    },
  };
}

/**
 * Create MCP server configuration from environment variables
 */
function createMCPServerConfig(): MCPServerConfig {
  const logLevel = (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error";

  return {
    name: process.env.MCP_SERVER_NAME || "shopify-admin-mcp-server",
    version: process.env.MCP_SERVER_VERSION || "2.0.0",
    defaultToolConfig: {
      maxRetries: parseInt(process.env.TOOL_MAX_RETRIES || "2", 10),
      timeout: parseInt(process.env.TOOL_TIMEOUT || "15000", 10),
      includeCost: process.env.INCLUDE_COST_INFO !== "false",
      defaultPageSize: parseInt(process.env.DEFAULT_PAGE_SIZE || "50", 10),
    },
    logging: {
      level: logLevel,
      logQueries: process.env.LOG_QUERIES === "true",
      logResponses: process.env.LOG_RESPONSES === "true",
      logPerformance: process.env.LOG_PERFORMANCE === "true",
    },
    features: {
      enableBulkOperations: process.env.ENABLE_BULK_OPERATIONS !== "false",
      enableWebhooks: process.env.ENABLE_WEBHOOKS !== "false",
      enableAnalytics: process.env.ENABLE_ANALYTICS !== "false",
      enableExperimental: process.env.ENABLE_EXPERIMENTAL === "true",
    },
  };
}

/**
 * Create complete application configuration
 */
function createAppConfig(): AppConfig {
  validateEnvironment();

  const environment = (process.env.NODE_ENV || "development") as
    | "development"
    | "staging"
    | "production";
  const debug = process.env.DEBUG === "true" || environment === "development";

  return {
    shopify: createShopifyConfig(),
    server: createMCPServerConfig(),
    environment,
    debug,
  };
}

/**
 * Global application configuration instance
 */
export const appConfig: AppConfig = createAppConfig();

/**
 * Configuration validation utilities
 */
export const configUtils = {
  /**
   * Validate that all required configuration is present
   */
  validate(): boolean {
    try {
      validateEnvironment();
      return true;
    } catch (error) {
      console.error("Configuration validation failed:", error);
      return false;
    }
  },

  /**
   * Get configuration summary for logging
   */
  getSummary(): Record<string, any> {
    return {
      environment: appConfig.environment,
      debug: appConfig.debug,
      shopify: {
        storeDomain: appConfig.shopify.storeDomain,
        apiVersion: appConfig.shopify.apiVersion,
        hasAccessToken: !!appConfig.shopify.accessToken,
        maxRetries: appConfig.shopify.maxRetries,
        timeout: appConfig.shopify.timeout,
      },
      server: {
        name: appConfig.server.name,
        version: appConfig.server.version,
        logLevel: appConfig.server.logging.level,
        features: appConfig.server.features,
      },
    };
  },

  /**
   * Check if a feature is enabled
   */
  isFeatureEnabled(feature: keyof MCPServerConfig["features"]): boolean {
    return appConfig.server.features[feature];
  },

  /**
   * Get GraphQL endpoint with authentication headers
   */
  getGraphQLConfig() {
    return {
      endpoint: appConfig.shopify.graphqlEndpoint,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": appConfig.shopify.accessToken,
        "User-Agent": `${appConfig.server.name}/${appConfig.server.version}`,
      },
    };
  },

  /**
   * Get REST API configuration
   */
  getRESTConfig() {
    return {
      baseURL: appConfig.shopify.restEndpoint,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": appConfig.shopify.accessToken,
        "User-Agent": `${appConfig.server.name}/${appConfig.server.version}`,
      },
      timeout: appConfig.shopify.timeout,
    };
  },
} as const;

/**
 * Environment-specific configuration overrides
 */
export const environmentConfig = {
  development: {
    logging: {
      level: "debug" as const,
      logQueries: true,
      logResponses: true,
      logPerformance: true,
    },
  },
  staging: {
    logging: {
      level: "info" as const,
      logQueries: false,
      logResponses: false,
      logPerformance: true,
    },
  },
  production: {
    logging: {
      level: "warn" as const,
      logQueries: false,
      logResponses: false,
      logPerformance: false,
    },
  },
} as const;

// Apply environment-specific overrides
if (environmentConfig[appConfig.environment]) {
  Object.assign(appConfig.server.logging, environmentConfig[appConfig.environment].logging);
}

// Export configuration for use throughout the application
export default appConfig;
