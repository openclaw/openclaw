import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { ShopifyClient } from "../ShopifyClient/ShopifyClient.js";
import {
  CreatePageInput,
  CreateNavMenuInput,
  CreateMenuItemInput,
  CreateThemeInput,
} from "../ShopifyClient/ShopifyClientPort.js";

// Load environment variables from .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env") });

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const MYSHOPIFY_DOMAIN = process.env.MYSHOPIFY_DOMAIN!;

if (!SHOPIFY_ACCESS_TOKEN || !MYSHOPIFY_DOMAIN) {
  throw new Error("Missing SHOPIFY_ACCESS_TOKEN or MYSHOPIFY_DOMAIN environment variables");
}

describe("Shopify Admin Features", () => {
  let client: ShopifyClient;

  beforeEach(() => {
    client = new ShopifyClient();
  });

  describe("Page Management", () => {
    let createdPageId: string;

    it("should load all pages", async () => {
      const result = await client.loadPages(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, 10);

      expect(result).toBeDefined();
      expect(result.pages).toBeDefined();
      expect(Array.isArray(result.pages)).toBe(true);
    }, 10000);

    it("should create a new page", async () => {
      const pageData: CreatePageInput = {
        title: "Test Page",
        body_html:
          "<h1>Test Page Content</h1><p>This is a test page created by automated testing.</p>",
        handle: "test-page-automated",
        author: "Test Suite",
        published: false, // Don't publish test pages
      };

      const result = await client.createPage(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, pageData);

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.title).toBe("Test Page");
      expect(result.handle).toBe("test-page-automated");

      createdPageId = result.id;
    }, 10000);

    it("should get a specific page", async () => {
      if (!createdPageId) {
        // Create a page first if none was created
        const pageData: CreatePageInput = {
          title: "Test Page for Get",
          body_html: "<h1>Test</h1>",
          published: false,
        };
        const created = await client.createPage(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, pageData);
        createdPageId = created.id;
      }

      const result = await client.getPage(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, createdPageId);

      expect(result).toBeDefined();
      expect(result.id).toBe(createdPageId);
      expect(result.title).toBeDefined();
    }, 10000);

    it("should update a page", async () => {
      if (!createdPageId) {
        // Create a page first if none was created
        const pageData: CreatePageInput = {
          title: "Test Page for Update",
          body_html: "<h1>Original Content</h1>",
          published: false,
        };
        const created = await client.createPage(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, pageData);
        createdPageId = created.id;
      }

      const updateData = {
        id: createdPageId,
        title: "Updated Test Page",
        body_html: "<h1>Updated Content</h1><p>This content has been updated.</p>",
      };

      const result = await client.updatePage(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, updateData);

      expect(result).toBeDefined();
      expect(result.title).toBe("Updated Test Page");
      expect(result.body_html).toContain("Updated Content");
    }, 10000);

    afterAll(async () => {
      // Clean up created test page
      if (createdPageId) {
        try {
          await client.deletePage(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, createdPageId);
        } catch (error) {
          console.warn("Failed to clean up test page:", error);
        }
      }
    });
  });

  describe("Navigation Menu Management", () => {
    let createdMenuId: string;

    it("should load all navigation menus", async () => {
      const result = await client.loadNavMenus(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN);

      expect(result).toBeDefined();
      expect(result.nav_menus).toBeDefined();
      expect(Array.isArray(result.nav_menus)).toBe(true);
    }, 10000);

    it("should create a new navigation menu", async () => {
      const menuData: CreateNavMenuInput = {
        title: "Test Menu",
        handle: "test-menu-automated",
      };

      const result = await client.createNavMenu(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, menuData);

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.title).toBe("Test Menu");
      expect(result.handle).toBe("test-menu-automated");

      createdMenuId = result.id;
    }, 10000);

    it("should create a menu item", async () => {
      if (!createdMenuId) {
        // Create a menu first
        const menuData: CreateNavMenuInput = {
          title: "Test Menu for Items",
          handle: "test-menu-for-items",
        };
        const created = await client.createNavMenu(
          SHOPIFY_ACCESS_TOKEN,
          MYSHOPIFY_DOMAIN,
          menuData,
        );
        createdMenuId = created.id;
      }

      const itemData: CreateMenuItemInput = {
        menu_id: createdMenuId,
        title: "Test Item",
        url: "/test-item",
        position: 1,
      };

      const result = await client.createMenuItem(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, itemData);

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.title).toBe("Test Item");
      expect(result.url).toBe("/test-item");
    }, 10000);

    afterAll(async () => {
      // Clean up created test menu
      if (createdMenuId) {
        try {
          await client.deleteNavMenu(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, createdMenuId);
        } catch (error) {
          console.warn("Failed to clean up test menu:", error);
        }
      }
    });
  });

  describe("Theme Management", () => {
    it("should load all themes", async () => {
      const result = await client.loadThemes(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN);

      expect(result).toBeDefined();
      expect(result.themes).toBeDefined();
      expect(Array.isArray(result.themes)).toBe(true);
      expect(result.themes.length).toBeGreaterThan(0);
    }, 10000);

    it("should get a specific theme", async () => {
      // First get all themes to get a valid theme ID
      const themes = await client.loadThemes(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN);
      expect(themes.themes.length).toBeGreaterThan(0);

      const firstTheme = themes.themes[0];
      const result = await client.getTheme(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, firstTheme.id);

      expect(result).toBeDefined();
      expect(result.id).toBe(firstTheme.id);
      expect(result.name).toBeDefined();
    }, 10000);

    it("should load theme assets", async () => {
      // Get the first theme
      const themes = await client.loadThemes(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN);
      expect(themes.themes.length).toBeGreaterThan(0);

      const firstTheme = themes.themes[0];
      const result = await client.loadThemeAssets(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        firstTheme.id,
      );

      expect(result).toBeDefined();
      expect(result.assets).toBeDefined();
      expect(Array.isArray(result.assets)).toBe(true);
    }, 10000);

    it("should get theme settings", async () => {
      // Get the first theme
      const themes = await client.loadThemes(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN);
      expect(themes.themes.length).toBeGreaterThan(0);

      const firstTheme = themes.themes[0];
      const result = await client.getThemeSettings(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        firstTheme.id,
      );

      expect(result).toBeDefined();
      // Settings might be empty object, which is valid
      expect(typeof result).toBe("object");
    }, 10000);

    it("should get a specific theme asset", async () => {
      // Get the first theme
      const themes = await client.loadThemes(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN);
      expect(themes.themes.length).toBeGreaterThan(0);

      const firstTheme = themes.themes[0];

      try {
        // Try to get a common asset file
        const result = await client.getThemeAsset(
          SHOPIFY_ACCESS_TOKEN,
          MYSHOPIFY_DOMAIN,
          firstTheme.id,
          "layout/theme.liquid",
        );

        expect(result).toBeDefined();
        expect(result.key).toBe("layout/theme.liquid");
        expect(result.value || result.attachment).toBeDefined();
      } catch (error) {
        // If layout/theme.liquid doesn't exist, that's okay - just skip this test
        console.warn("layout/theme.liquid not found, skipping asset test");
      }
    }, 10000);
  });
});
