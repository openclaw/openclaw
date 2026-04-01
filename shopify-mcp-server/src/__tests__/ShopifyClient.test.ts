import { config } from "dotenv";
import { ShopifyClient } from "../ShopifyClient/ShopifyClient.js";
import {
  CreateBasicDiscountCodeInput,
  CreateDraftOrderPayload,
  ShopifyWebhookTopic,
} from "../ShopifyClient/ShopifyClientPort.js";

// Load environment variables from .env file
config();

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const MYSHOPIFY_DOMAIN = process.env.MYSHOPIFY_DOMAIN;

if (!SHOPIFY_ACCESS_TOKEN || !MYSHOPIFY_DOMAIN) {
  throw new Error("SHOPIFY_ACCESS_TOKEN and MYSHOPIFY_DOMAIN must be set in .env file");
}

describe("ShopifyClient", () => {
  let client: ShopifyClient;

  beforeEach(() => {
    client = new ShopifyClient();
  });

  describe("Products", () => {
    it("should load products", async () => {
      const products = await client.loadProducts(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, "*", 100);
      expect(products).toBeDefined();
      expect(products.products).toBeDefined();
      expect(products.currencyCode).toBeDefined();
    });

    it("should load products by collection id", async () => {
      // load collections to get a valid collection id
      const collections = await client.loadCollections(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, {
        limit: 1,
      });
      const collectionId = collections.collections[0]?.id.toString();
      expect(collectionId).toBeDefined();

      const products = await client.loadProductsByCollectionId(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        collectionId,
        10,
      );
      expect(products).toBeDefined();
      expect(products.products).toBeDefined();
      expect(products.currencyCode).toBeDefined();
    });

    it("should load products by ids", async () => {
      // load products to get a valid product id
      const allProducts = await client.loadProducts(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        "*",
        100,
      );
      const productIds = allProducts.products.map((product) => product.id.toString());
      const products = await client.loadProductsByIds(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        productIds,
      );
      expect(products).toBeDefined();
      expect(products.products).toBeDefined();
      expect(products.currencyCode).toBeDefined();
    });

    it("should load variants by ids", async () => {
      // load products to get a valid product id
      const allProducts = await client.loadProducts(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        "*",
        100,
      );

      const variantIds = allProducts.products.flatMap((product) =>
        product.variants.edges.map((variant) => variant.node.id.toString()),
      );

      const variants = await client.loadVariantsByIds(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        variantIds,
      );
      expect(variants).toBeDefined();
      expect(variants.variants).toBeDefined();
      expect(variants.currencyCode).toBeDefined();
    });
  });

  describe("Customers", () => {
    it("should load customers", async () => {
      const customers = await client.loadCustomers(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, 100);
      expect(customers).toBeDefined();
      expect(customers.customers).toBeDefined();
    });

    it("should tag customer", async () => {
      // load customers to get a valid customer id
      const customers = await client.loadCustomers(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, 100);
      const customerId = customers.customers[0]?.id?.toString();
      expect(customerId).toBeDefined();
      if (!customerId) {
        throw new Error("No customer id found");
      }

      const tagged = await client.tagCustomer(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        ["test"],
        customerId,
      );
      expect(tagged).toBe(true);
    });
  });

  describe("Orders", () => {
    it("should load orders", async () => {
      const orders = await client.loadOrders(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, {
        first: 100,
      });
      expect(orders).toBeDefined();
      expect(orders.orders).toBeDefined();
      expect(orders.pageInfo).toBeDefined();
    });

    it("should load single order", async () => {
      // load orders to get a valid order id
      const orders = await client.loadOrders(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, {
        first: 100,
      });
      const orderId = orders.orders[0]?.id?.toString();
      expect(orderId).toBeDefined();
      if (!orderId) {
        throw new Error("No order id found");
      }

      const order = await client.loadOrder(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, {
        orderId: client.getIdFromGid(orderId),
      });
      expect(order).toBeDefined();
      expect(order.id).toBeDefined();
    });
  });

  describe("Discounts", () => {
    it("should create and delete basic discount code", async () => {
      const discountInput: CreateBasicDiscountCodeInput = {
        title: "Test Discount",
        code: "TEST123",
        startsAt: new Date().toISOString(),
        valueType: "percentage",
        value: 0.1,
        includeCollectionIds: [],
        excludeCollectionIds: [],
        appliesOncePerCustomer: true,
        combinesWith: {
          productDiscounts: true,
          orderDiscounts: true,
          shippingDiscounts: true,
        },
      };

      const discount = await client.createBasicDiscountCode(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        discountInput,
      );
      expect(discount).toBeDefined();
      expect(discount.id).toBeDefined();
      expect(discount.code).toBe(discountInput.code);

      await client.deleteBasicDiscountCode(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, discount.id);
    });
  });

  describe("Draft Orders", () => {
    it("should create and complete draft order", async () => {
      // load products to get a valid variant id
      const allProducts = await client.loadProducts(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        null,
        100,
      );
      const variantIds = allProducts.products.flatMap((product) =>
        product.variants.edges.map((variant) => variant.node.id.toString()),
      );
      const variantId = variantIds[0];
      expect(variantId).toBeDefined();
      if (!variantId) {
        throw new Error("No variant id found");
      }
      const draftOrderData: CreateDraftOrderPayload = {
        lineItems: [
          {
            variantId,
            quantity: 1,
          },
        ],
        email: "test@example.com",
        shippingAddress: {
          address1: "123 Test St",
          city: "Test City",
          province: "Test Province",
          country: "Test Country",
          zip: "12345",
          firstName: "Test",
          lastName: "User",
          countryCode: "US",
        },
        billingAddress: {
          address1: "123 Test St",
          city: "Test City",
          province: "Test Province",
          country: "Test Country",
          zip: "12345",
          firstName: "Test",
          lastName: "User",
          countryCode: "US",
        },
        tags: "test",
        note: "Test draft order",
      };

      const draftOrder = await client.createDraftOrder(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        draftOrderData,
      );
      expect(draftOrder).toBeDefined();
      expect(draftOrder.draftOrderId).toBeDefined();

      const completedOrder = await client.completeDraftOrder(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        draftOrder.draftOrderId,
        draftOrderData.lineItems[0].variantId,
      );
      expect(completedOrder).toBeDefined();
      expect(completedOrder.orderId).toBeDefined();
    });
  });

  describe("Collections", () => {
    it("should load collections", async () => {
      const collections = await client.loadCollections(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, {
        limit: 10,
      });
      expect(collections).toBeDefined();
      expect(collections.collections).toBeDefined();
    });
  });

  describe("Shop", () => {
    it("should load shop", async () => {
      const shop = await client.loadShop(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN);
      expect(shop).toBeDefined();
      expect(shop.shop).toBeDefined();
    });

    it("should load shop details", async () => {
      const shopDetails = await client.loadShopDetail(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN);
      expect(shopDetails).toBeDefined();
      expect(shopDetails.data).toBeDefined();
    });
  });

  describe("Webhooks", () => {
    it("should manage webhooks", async () => {
      const callbackUrl = "https://example.com/webhook";
      const topic = ShopifyWebhookTopic.ORDERS_UPDATED;

      const webhook = await client.subscribeWebhook(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        callbackUrl,
        topic,
      );
      expect(webhook).toBeDefined();
      expect(webhook.id).toBeDefined();

      const foundWebhook = await client.findWebhookByTopicAndCallbackUrl(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        callbackUrl,
        topic,
      );
      expect(foundWebhook).toBeDefined();
      expect(foundWebhook?.id).toBe(webhook.id);

      if (!foundWebhook?.id) {
        throw new Error("No webhook id found");
      }
      const webhookId = foundWebhook.id;
      await client.unsubscribeWebhook(SHOPIFY_ACCESS_TOKEN, MYSHOPIFY_DOMAIN, webhookId);

      const deletedWebhook = await client.findWebhookByTopicAndCallbackUrl(
        SHOPIFY_ACCESS_TOKEN,
        MYSHOPIFY_DOMAIN,
        callbackUrl,
        topic,
      );
      expect(deletedWebhook).toBeNull();
    });
  });

  describe("Utility Methods", () => {
    it("should get ID from GID", () => {
      const gid = "gid://shopify/Product/123456789";
      const id = client.getIdFromGid(gid);
      expect(id).toBe("123456789");
    });
  });
});
