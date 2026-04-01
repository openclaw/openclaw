export type Nullable<T> = T | null;
export type ISODate = string;
export type Maybe<T> = T | null | undefined;

export type CreateDiscountCodeResponse = {
  id: string;
  priceRuleId: string;
  code: string;
  usageCount: number;
};

export enum ShopifyWebhookTopicGraphql {
  ORDERS_UPDATED = "ORDERS_UPDATED",
}

export enum ShopifyWebhookTopic {
  ORDERS_UPDATED = "orders/updated",
}

export type ShopifyWebhook = {
  id: string;
  callbackUrl: string;
  topic: ShopifyWebhookTopic;
};

export type ShopifyPriceRule = {
  id: number;
  value_type: string;
  value: string;
  customer_selection: string;
  target_type: string;
  target_selection: string;
  allocation_method: string;
  allocation_limit: number | null;
  once_per_customer: boolean;
  usage_limit: number | null;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
  entitled_product_ids: number[];
  entitled_variant_ids: number[];
  entitled_collection_ids: number[];
  entitled_country_ids: number[];
  prerequisite_product_ids: number[];
  prerequisite_variant_ids: number[];
  prerequisite_collection_ids: number[];
  prerequisite_saved_search_ids: number[];
  prerequisite_customer_ids: number[];
  prerequisite_subtotal_range: {
    greater_than_or_equal_to: string;
  } | null;
  prerequisite_quantity_range: {
    greater_than_or_equal_to: number;
  } | null;
  prerequisite_shipping_price_range: {
    less_than_or_equal_to: string;
  } | null;
  prerequisite_to_entitlement_quantity_ratio: {
    prerequisite_quantity: number;
    entitled_quantity: number;
  } | null;
  title: string;
  admin_graphql_api_id: string;
};

export type ShopifyCreatePriceRuleResponse = {
  price_rule: ShopifyPriceRule;
};

export type ShopifyDiscountCode = {
  id: number;
  price_rule_id: number;
  code: string;
  usage_count: number;
  created_at: string;
  updated_at: string;
};

export type ShopifyCreateDiscountCodeResponse = {
  discount_code: ShopifyDiscountCode;
};

export type CreatePriceRuleInput = {
  title: string;
  targetType: "LINE_ITEM" | "SHIPPING_LINE";
  allocationMethod: "ACROSS" | "EACH";
  valueType: "fixed_amount" | "percentage";
  value: string;
  entitledCollectionIds: string[];
  usageLimit?: number;
  startsAt: ISODate;
  endsAt?: ISODate;
};

export type CreateBasicDiscountCodeInput = {
  title: string;
  code: string;
  startsAt: ISODate;
  endsAt?: ISODate;
  valueType: string;
  value: number;
  usageLimit?: number;
  includeCollectionIds: string[];
  excludeCollectionIds: string[];
  appliesOncePerCustomer: boolean;
  combinesWith: {
    productDiscounts: boolean;
    orderDiscounts: boolean;
    shippingDiscounts: boolean;
  };
};

export type CreateBasicDiscountCodeResponse = {
  id: string;
  code: string;
};

export type BasicDiscountCodeResponse = {
  data: {
    discountCodeBasicCreate: {
      codeDiscountNode: {
        id: string;
        codeDiscount: {
          title: string;
          codes: {
            nodes: Array<{
              code: string;
            }>;
          };
          startsAt: string;
          endsAt: string;
          customerSelection: {
            allCustomers: boolean;
          };
          customerGets: {
            appliesOnOneTimePurchase: boolean;
            appliesOnSubscription: boolean;
            value: {
              percentage?: number;
              amount?: {
                amount: number;
                currencyCode: string;
              };
            };
            items: {
              allItems: boolean;
            };
          };
          appliesOncePerCustomer: boolean;
          recurringCycleLimit: number;
        };
      };
      userErrors: Array<{
        field: string[];
        code: string;
        message: string;
      }>;
    };
  };
};

export type CreatePriceRuleResponse = {
  id: string;
};

type DiscountCode = {
  code: string | null;
  amount: string | null;
  type: string | null;
};

export type ShopifyCustomer = {
  id?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  orders_count?: number;
  email_marketing_consent?: {
    state?: "subscribed" | "not_subscribed" | null;
    opt_in_level?: "single_opt_in" | "confirmed_opt_in" | "unknown" | null;
    consent_updated_at?: string;
  };

  sms_marketing_consent?: {
    state?: string;
    opt_in_level?: string | null;
    consent_updated_at?: string;
    consent_collected_from?: string;
  };
  tags?: string;
  currency?: string;
  default_address?: {
    first_name?: string | null;
    last_name?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
    zip?: string | null;
    phone?: string | null;
    name?: string | null;
    province_code?: string | null;
    country_code?: string | null;
    country_name?: string | null;
  };
};

export type LoadCustomersResponse = {
  customers: Array<ShopifyCustomer>;
  next?: string | undefined;
};

export type ShopifyOrder = {
  id: string;
  createdAt: string;
  currencyCode: string;
  discountApplications: {
    nodes: Array<{
      code: string | null;
      value: {
        amount: string | null;
        percentage: number | null;
      };
      __typename: string;
    }>;
  };
  displayFinancialStatus: string | null;
  name: string;
  totalPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
    presentmentMoney: { amount: string; currencyCode: string };
  };
  totalShippingPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
    presentmentMoney: { amount: string; currencyCode: string };
  };
  customer?: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
  };
};

export type ShopifyOrdersResponse = {
  data: {
    orders: {
      edges: Array<{
        node: ShopifyOrder;
      }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string;
      };
    };
  };
};

export function isShopifyOrder(shopifyOrder: any): shopifyOrder is ShopifyOrder {
  return (
    shopifyOrder &&
    "id" in shopifyOrder &&
    "createdAt" in shopifyOrder &&
    "currencyCode" in shopifyOrder &&
    "discountApplications" in shopifyOrder &&
    "displayFinancialStatus" in shopifyOrder &&
    "name" in shopifyOrder &&
    "totalPriceSet" in shopifyOrder &&
    "totalShippingPriceSet" in shopifyOrder
  );
}

// Shopify webhook payload is the same type as the order
// We expose the same type for having an easier to read and consistent API across all webshop clients
export type ShopifyOrderWebhookPayload = ShopifyOrder;

export function isShopifyOrderWebhookPayload(
  webhookPayload: any,
): webhookPayload is ShopifyOrderWebhookPayload {
  return isShopifyOrder(webhookPayload);
}

export type ShopifyCollectionsQueryParams = {
  sinceId?: string; // Retrieve all orders after the specified ID
  name?: string;
  limit: number;
};

export type ShopifyCollection = {
  id: number;
  handle: string;
  title: string;
  updated_at: string;
  body_html: Nullable<string>;
  published_at: string;
  sort_order: string;
  template_suffix?: Nullable<string>;
  published_scope: string;
  image?: {
    src: string;
    alt: string;
  };
};

export type ShopifySmartCollectionsResponse = {
  smart_collections: ShopifyCollection[];
};

export type ShopifyCustomCollectionsResponse = {
  custom_collections: ShopifyCollection[];
};

export type LoadCollectionsResponse = {
  collections: ShopifyCollection[];
  next?: string;
};

export type ShopifyShop = {
  id: string;
  name: string;
  domain: string;
  myshopify_domain: string;
  currency: string;
  enabled_presentment_currencies: string[];
  address1: string;
  created_at: string;
  updated_at: string;
};

export type LoadStorefrontsResponse = {
  shop: ShopifyShop;
};

export type ShopifyQueryParams = {
  query?: string; // Custom query string for advanced filtering
  sortKey?: "PROCESSED_AT" | "TOTAL_PRICE" | "ID" | "CREATED_AT" | "UPDATED_AT" | "ORDER_NUMBER";
  reverse?: boolean;
  before?: string;
  after?: string;
  // Keeping these for backwards compatibility, but they should be used in query string
  sinceId?: string;
  updatedAtMin?: string;
  createdAtMin?: string;
  financialStatus?:
    | "AUTHORIZED"
    | "PENDING"
    | "PAID"
    | "PARTIALLY_PAID"
    | "REFUNDED"
    | "VOIDED"
    | "PARTIALLY_REFUNDED"
    | "ANY"
    | "UNPAID";
  ids?: string[];
  status?: "OPEN" | "CLOSED" | "CANCELLED" | "ANY";
  limit?: number;
};

export type ShippingZone = {
  id: string;
  name: string;
  countries: Array<{
    id: string;
    name: string;
    code: string;
  }>;
};

export type ShopifyLoadOrderQueryParams = {
  orderId: string;
  fields?: string[];
};

export type ProductImage = {
  src: string;
  height: number;
  width: number;
};

export type ProductOption = {
  id: string;
  name: string;
  values: string[];
};

export type SelectedProductOption = {
  name: string;
  value: string;
};

export type ProductVariant = {
  id: string;
  title: string;
  price: string;
  sku: string;
  availableForSale: boolean;
  image: Nullable<ProductImage>;
  inventoryPolicy: "CONTINUE" | "DENY";
  selectedOptions: SelectedProductOption[];
};

export type ShopResponse = {
  data: {
    shop: {
      shipsToCountries: string[];
    };
  };
};

export type MarketResponse = {
  data: {
    market: {
      name: string;
      enabled: string;
      regions: {
        nodes: {
          name: string;
          code: string;
        };
      };
    };
  };
};

export type GetPriceRuleInput = { query?: string };

export type GetPriceRuleResponse = {
  priceRules: {
    nodes: [
      {
        id: string;
        title: string;
        status: string;
      },
    ];
  };
};

export type ProductVariantWithProductDetails = ProductVariant & {
  product: {
    id: string;
    title: string;
    description: string;
    images: {
      edges: {
        node: ProductImage;
      }[];
    };
  };
};

export type ProductNode = {
  id: string;
  handle: string;
  title: string;
  description: string;
  publishedAt: string;
  updatedAt: string;
  options: ProductOption[];
  images: {
    edges: {
      node: ProductImage;
    }[];
  };
  variants: {
    edges: {
      node: ProductVariant;
    }[];
  };
};

export type LoadProductsResponse = {
  currencyCode: string;
  products: ProductNode[];
  next?: string;
};

export type LoadProductsByIdsResponse = {
  currencyCode: string;
  products: ProductNode[];
};

export type LoadVariantsByIdResponse = {
  currencyCode: string;
  variants: ProductVariantWithProductDetails[];
};

export type CreateDraftOrderPayload = {
  lineItems: Array<{
    variantId: string;
    quantity: number;
    appliedDiscount?: {
      title: string;
      value: number;
      valueType: "FIXED_AMOUNT" | "PERCENTAGE";
    };
  }>;
  shippingAddress: {
    address1: string;
    address2?: string;
    countryCode: string;
    firstName: string;
    lastName: string;
    zip: string;
    city: string;
    country: string;
    province?: string;
    provinceCode?: string;
    phone?: string;
  };
  billingAddress: {
    address1: string;
    address2?: string;
    countryCode: string;
    firstName: string;
    lastName: string;
    zip: string;
    city: string;
    country: string;
    province?: string;
    provinceCode?: string;
    phone?: string;
  };
  email: string;
  tags: string;
  note: string;
};

export type DraftOrderResponse = {
  draftOrderId: string;
  draftOrderName: string;
};

export type CompleteDraftOrderResponse = {
  draftOrderId: string;
  draftOrderName: string;
  orderId: string;
};

function serializeError(err: any): any {
  if (Array.isArray(err)) {
    return err.map((item) => serializeError(item));
  } else if (typeof err === "object" && err !== null) {
    const result: Record<string, any> = {};
    Object.getOwnPropertyNames(err).forEach((key) => {
      result[key] = serializeError(err[key]);
    });
    return result;
  }
  return err;
}

type InnerError = Error | Error[] | string | string[] | Record<string, any> | undefined;

export interface CustomErrorPayload {
  customCode?: string;
  message?: string;

  innerError?: InnerError;

  /**
   * Used to add custom data that will be logged
   */
  contextData?: any;
}

export class CustomError extends Error {
  public code: string;

  public innerError: InnerError;

  public contextData: any;

  constructor(message: string, code: string, payload: CustomErrorPayload = {}) {
    super(message);
    this.code = payload.customCode ? `${code}.${payload.customCode}` : code;
    if (payload.message) this.message = message;
    this.innerError = payload.innerError;
    this.contextData = payload.contextData;
    this.name = this.constructor.name;
  }

  toJSON(): unknown {
    return {
      message: this.message,
      innerError: serializeError(this.innerError),
      name: this.name,
      code: this.code,
      contextData: this.contextData,
    };
  }

  static is<E extends typeof CustomError & { code: string }>(
    error: any,
    ErrorClass: E,
  ): error is InstanceType<E> {
    return "code" in error && error.code === ErrorClass.code;
  }
}

export class ShopifyClientErrorBase extends CustomError {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  static make(message: string, code: string) {
    return class extends ShopifyClientErrorBase {
      static code = code;

      constructor(payload?: CustomErrorPayload) {
        super(message, code, payload);
      }
    };
  }
}

export class ShopifyCastObjError extends ShopifyClientErrorBase.make(
  "Error occurred on Shopify cast object",
  "SHOPIFY_CLIENT.SHOPIFY_CAST_ERROR",
) {}

export class ShopifyAuthorizationError extends ShopifyClientErrorBase.make(
  "Shopify authorization error",
  "SHOPIFY_CLIENT.AUTHORIZATION_ERROR",
) {}

export class ShopifyRequestError extends ShopifyClientErrorBase.make(
  "Shopify request error",
  "SHOPIFY_CLIENT.REQUEST_ERROR",
) {}

export class ShopifyInputError extends ShopifyClientErrorBase.make(
  "Shopify input error",
  "SHOPIFY_CLIENT.INPUT_ERROR",
) {}

export class ShopifyRateLimitingError extends ShopifyClientErrorBase.make(
  "Shopify rate limiting error",
  "SHOPIFY_CLIENT.RATE_LIMITING_ERROR",
) {}

export class ShopifyServerInfrastructureError extends ShopifyClientErrorBase.make(
  "Shopify server or infrastructure error",
  "SHOPIFY_CLIENT.SERVER_INFRASTRUCTURE_ERROR",
) {}

export class ShopifyPaymentError extends ShopifyClientErrorBase.make(
  "Shopify payment error",
  "SHOPIFY_CLIENT.PAYMENT_ERROR",
) {}
export class GeneralShopifyClientError extends ShopifyClientErrorBase.make(
  "Error occurred on Shopify API client",
  "SHOPIFY_CLIENT.SHOPIFY_CLIENT_ERROR",
) {}
export class ShopifyWebShopNotFoundError extends ShopifyClientErrorBase.make(
  "The Shopify webshop not found",
  "SHOPIFY_CLIENT.WEBSHOP_CONNECTION_NOT_FOUND",
) {}

export class ShopifyProductVariantNotFoundError extends ShopifyClientErrorBase.make(
  "The Shopify product variant not found",
  "SHOPIFY_CLIENT.PRODUCT_VARIANT_NOT_FOUND",
) {}

export class ShopifyProductVariantNotAvailableForSaleError extends ShopifyClientErrorBase.make(
  "The Shopify product variant is not available for sale",
  "SHOPIFY_CLIENT.PRODUCT_VARIANT_NOT_AVAILABLE_FOR_SALE",
) {}

export class InvalidShopifyCurrencyError extends ShopifyClientErrorBase.make(
  "The Shopify currency is invalid",
  "SHOPIFY_CLIENT.INVALID_CURRENCY",
) {}

export class ShopifyWebhookNotFoundError extends ShopifyClientErrorBase.make(
  "The Shopify webhook not found",
  "SHOPIFY_CLIENT.WEBHOOK_NOT_FOUND",
) {}

export class ShopifyWebhookAlreadyExistsError extends ShopifyClientErrorBase.make(
  "The Shopify webhook already exists",
  "SHOPIFY_CLIENT.WEBHOOK_ALREADY_EXISTS",
) {}

export function getHttpShopifyError(
  error: any,
  statusCode: number,
  contextData?: Record<string, any>,
): ShopifyClientErrorBase {
  switch (statusCode) {
    case 401:
    case 403:
    case 423:
    case 430:
      return new ShopifyAuthorizationError({ innerError: error, contextData });

    case 400:
    case 405:
    case 406:
    case 414:
    case 415:
    case 783:
      return new ShopifyRequestError({ innerError: error, contextData });

    case 404:
    case 409:
    case 422:
      return new ShopifyInputError({ innerError: error, contextData });

    case 429:
      return new ShopifyRateLimitingError({ innerError: error, contextData });

    case 500:
    case 501:
    case 502:
    case 503:
    case 504:
    case 530:
    case 540:
      return new ShopifyServerInfrastructureError({
        innerError: error,
        contextData,
      });

    case 402:
      return new ShopifyPaymentError({ innerError: error, contextData });

    default:
      return new GeneralShopifyClientError({
        innerError: error,
        contextData,
      });
  }
}

export function getGraphqlShopifyUserError(
  errors: any[],
  contextData?: Record<string, any>,
): ShopifyClientErrorBase {
  const hasErrorWithMessage = (messages: string[]): boolean =>
    errors.some((error) => messages.includes(error.message));

  if (hasErrorWithMessage(["Product variant not found."])) {
    return new ShopifyProductVariantNotFoundError({
      innerError: errors,
      contextData,
    });
  }

  if (hasErrorWithMessage(["Webhook subscription does not exist"])) {
    return new ShopifyWebhookNotFoundError({
      innerError: errors,
      contextData,
    });
  }

  if (hasErrorWithMessage(["Address for this topic has already been taken"])) {
    return new ShopifyWebhookAlreadyExistsError({
      innerError: errors,
      contextData,
    });
  }

  return new GeneralShopifyClientError({
    innerError: errors,
    contextData,
  });
}

export function getGraphqlShopifyError(
  errors: any[],
  statusCode: number,
  contextData?: Record<string, any>,
): ShopifyClientErrorBase {
  const hasErrorWithCode = (codes: string[]): boolean =>
    errors.some((error) => codes.includes(error.extensions?.code));

  switch (statusCode) {
    case 403:
    case 423:
      return new ShopifyAuthorizationError({
        innerError: errors,
        contextData,
      });

    case 400:
      return new ShopifyRequestError({
        innerError: errors,
        contextData,
      });

    case 404:
      return new ShopifyInputError({
        innerError: errors,
        contextData,
      });

    case 500:
    case 501:
    case 502:
    case 503:
    case 504:
    case 530:
    case 540:
      return new ShopifyServerInfrastructureError({
        innerError: errors,
        contextData,
      });

    case 402:
      return new ShopifyPaymentError({
        innerError: errors,
        contextData,
      });

    default:
      if (hasErrorWithCode(["UNAUTHORIZED", "ACCESS_DENIED", "FORBIDDEN"])) {
        return new ShopifyAuthorizationError({
          innerError: errors,
          contextData,
        });
      }

      if (hasErrorWithCode(["UNPROCESSABLE"])) {
        return new ShopifyInputError({
          innerError: errors,
          contextData,
        });
      }

      if (hasErrorWithCode(["THROTTLED"])) {
        return new ShopifyRateLimitingError({
          innerError: errors,
          contextData,
        });
      }

      if (hasErrorWithCode(["INTERNAL_SERVER_ERROR"])) {
        return new ShopifyServerInfrastructureError({
          innerError: errors,
          contextData,
        });
      }

      return new GeneralShopifyClientError({
        innerError: errors,
        contextData,
      });
  }
}

export type ShopifyOrderGraphql = {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string;
  email: string;
  phone: string | null;
  totalPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
    presentmentMoney: { amount: string; currencyCode: string };
  };
  customer: {
    id: string;
    email: string;
  } | null;
  shippingAddress: {
    provinceCode: string | null;
    countryCode: string;
  } | null;
  lineItems: {
    nodes: Array<{
      id: string;
      title: string;
      quantity: number;
      originalTotalSet: {
        shopMoney: { amount: string; currencyCode: string };
      };
      variant: {
        id: string;
        title: string;
        sku: string | null;
        price: string;
      } | null;
    }>;
  };
};

export type ShopifyOrdersGraphqlQueryParams = {
  first?: number;
  after?: string;
  query?: string;
  sortKey?: "PROCESSED_AT" | "TOTAL_PRICE" | "ID" | "CREATED_AT" | "UPDATED_AT" | "ORDER_NUMBER";
  reverse?: boolean;
};

export type ShopifyOrdersGraphqlResponse = {
  orders: ShopifyOrderGraphql[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
};

// Admin & Storefront Management Types
export type ShopifyPage = {
  id: string;
  title: string;
  handle: string;
  body_html: string;
  summary_body?: string;
  author?: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  template_suffix?: string;
  shop_id: string;
};

export type CreatePageInput = {
  title: string;
  handle?: string;
  body_html: string;
  summary_body?: string;
  author?: string;
  published?: boolean;
  template_suffix?: string;
};

export type UpdatePageInput = {
  id: string;
  title?: string;
  handle?: string;
  body_html?: string;
  summary_body?: string;
  author?: string;
  published?: boolean;
  template_suffix?: string;
};

export type ShopifyNavMenu = {
  id: string;
  title: string;
  handle: string;
  created_at: string;
  updated_at: string;
};

export type ShopifyMenuItem = {
  id: string;
  title: string;
  url: string;
  parent_id?: string;
  position: number;
  created_at: string;
  updated_at: string;
};

export type CreateNavMenuInput = {
  title: string;
  handle?: string;
};

export type CreateMenuItemInput = {
  menu_id: string;
  title: string;
  url: string;
  parent_id?: string;
  position?: number;
};

export type ShopifyTheme = {
  id: string;
  name: string;
  role: "main" | "unpublished" | "demo";
  theme_store_id?: string;
  previewable: boolean;
  processing: boolean;
  created_at: string;
  updated_at: string;
};

export type ThemeAsset = {
  key: string;
  value?: string;
  attachment?: string;
  content_type: string;
  size: number;
  created_at: string;
  updated_at: string;
};

export type CreateThemeInput = {
  name: string;
  src?: string; // URL to ZIP file
  role?: "main" | "unpublished";
};

export type UpdateThemeAssetInput = {
  theme_id: string;
  key: string;
  value?: string;
  attachment?: string;
};

export type ThemeSettings = {
  [key: string]: any;
};

export type LoadPagesResponse = {
  pages: ShopifyPage[];
  next?: string;
};

export type LoadNavMenusResponse = {
  nav_menus: ShopifyNavMenu[];
};

export type LoadMenuItemsResponse = {
  menu_items: ShopifyMenuItem[];
};

export type LoadThemesResponse = {
  themes: ShopifyTheme[];
};

export type LoadThemeAssetsResponse = {
  assets: ThemeAsset[];
};

export interface ShopifyClientPort {
  createPriceRule(
    accessToken: string,
    shop: string,
    priceRuleInput: CreatePriceRuleInput,
  ): Promise<CreatePriceRuleResponse>;

  createDiscountCode(
    accessToken: string,
    shop: string,
    code: string,
    priceRuleId: string,
  ): Promise<CreateDiscountCodeResponse>;

  deletePriceRule(accessToken: string, shop: string, priceRuleId: string): Promise<void>;

  deleteDiscountCode(
    accessToken: string,
    shop: string,
    priceRuleId: string,
    discountCodeId: string,
  ): Promise<void>;

  createBasicDiscountCode(
    accessToken: string,
    shop: string,
    discountInput: CreateBasicDiscountCodeInput,
  ): Promise<CreateBasicDiscountCodeResponse>;

  deleteBasicDiscountCode(accessToken: string, shop: string, discountCodeId: string): Promise<void>;

  loadOrders(
    accessToken: string,
    shop: string,
    queryParams: ShopifyOrdersGraphqlQueryParams,
  ): Promise<ShopifyOrdersGraphqlResponse>;

  loadOrder(
    accessToken: string,
    myshopifyDomain: string,
    queryParams: ShopifyLoadOrderQueryParams,
  ): Promise<ShopifyOrder>;

  subscribeWebhook(
    accessToken: string,
    myshopifyDomain: string,
    callbackUrl: string,
    topic: ShopifyWebhookTopic,
  ): Promise<ShopifyWebhook>;

  unsubscribeWebhook(
    accessToken: string,
    myshopifyDomain: string,
    webhookId: string,
  ): Promise<void>;

  findWebhookByTopicAndCallbackUrl(
    accessToken: string,
    myshopifyDomain: string,
    callbackUrl: string,
    topic: ShopifyWebhookTopic,
  ): Promise<ShopifyWebhook | null>;

  loadCollections(
    accessToken: string,
    myshopifyDomain: string,
    queryParams: ShopifyQueryParams,
    next?: string,
  ): Promise<LoadCollectionsResponse>;

  loadShop(accessToken: string, myshopifyDomain: string): Promise<LoadStorefrontsResponse>;

  loadCustomers(
    accessToken: string,
    myshopifyDomain: string,
    limit?: number,
    next?: string,
  ): Promise<LoadCustomersResponse>;

  tagCustomer(
    accessToken: string,
    myshopifyDomain: string,
    tags: string[],
    customerId: string,
  ): Promise<boolean>;

  loadProducts(
    accessToken: string,
    myshopifyDomain: string,
    searchTitle: string | null,
    limit?: number,
    afterCursor?: string,
  ): Promise<LoadProductsResponse>;

  loadProductsByCollectionId(
    accessToken: string,
    myshopifyDomain: string,
    collectionId: string,
    limit?: number,
    afterCursor?: string,
  ): Promise<LoadProductsResponse>;

  loadProductsByIds(
    accessToken: string,
    shop: string,
    productIds: string[],
  ): Promise<LoadProductsByIdsResponse>;

  loadVariantsByIds(
    accessToken: string,
    shop: string,
    variantIds: string[],
  ): Promise<LoadVariantsByIdResponse>;

  createDraftOrder(
    accessToken: string,
    shop: string,
    draftOrderData: CreateDraftOrderPayload,
    idempotencyKey: string,
  ): Promise<DraftOrderResponse>;

  completeDraftOrder(
    accessToken: string,
    shop: string,
    draftOrderId: string,
    variantId: string,
  ): Promise<CompleteDraftOrderResponse>;

  getIdFromGid(gid: string): string;

  loadShopDetail(accessToken: string, shop: string): Promise<ShopResponse>;

  // Admin & Storefront Management Methods

  // Page Management
  loadPages(
    accessToken: string,
    shop: string,
    limit?: number,
    next?: string,
  ): Promise<LoadPagesResponse>;

  getPage(accessToken: string, shop: string, pageId: string): Promise<ShopifyPage>;

  createPage(accessToken: string, shop: string, pageData: CreatePageInput): Promise<ShopifyPage>;

  updatePage(accessToken: string, shop: string, pageData: UpdatePageInput): Promise<ShopifyPage>;

  deletePage(accessToken: string, shop: string, pageId: string): Promise<void>;

  // Navigation Menu Management
  loadNavMenus(accessToken: string, shop: string): Promise<LoadNavMenusResponse>;

  getNavMenu(accessToken: string, shop: string, menuId: string): Promise<ShopifyNavMenu>;

  createNavMenu(
    accessToken: string,
    shop: string,
    menuData: CreateNavMenuInput,
  ): Promise<ShopifyNavMenu>;

  updateNavMenu(
    accessToken: string,
    shop: string,
    menuId: string,
    menuData: Partial<CreateNavMenuInput>,
  ): Promise<ShopifyNavMenu>;

  deleteNavMenu(accessToken: string, shop: string, menuId: string): Promise<void>;

  // Menu Item Management
  loadMenuItems(accessToken: string, shop: string, menuId: string): Promise<LoadMenuItemsResponse>;

  createMenuItem(
    accessToken: string,
    shop: string,
    itemData: CreateMenuItemInput,
  ): Promise<ShopifyMenuItem>;

  updateMenuItem(
    accessToken: string,
    shop: string,
    itemId: string,
    itemData: Partial<Omit<CreateMenuItemInput, "menu_id">>,
  ): Promise<ShopifyMenuItem>;

  deleteMenuItem(accessToken: string, shop: string, itemId: string): Promise<void>;

  // Theme Management
  loadThemes(accessToken: string, shop: string): Promise<LoadThemesResponse>;

  getTheme(accessToken: string, shop: string, themeId: string): Promise<ShopifyTheme>;

  createTheme(
    accessToken: string,
    shop: string,
    themeData: CreateThemeInput,
  ): Promise<ShopifyTheme>;

  updateTheme(
    accessToken: string,
    shop: string,
    themeId: string,
    themeData: Partial<CreateThemeInput>,
  ): Promise<ShopifyTheme>;

  deleteTheme(accessToken: string, shop: string, themeId: string): Promise<void>;

  duplicateTheme(
    accessToken: string,
    shop: string,
    themeId: string,
    name: string,
  ): Promise<ShopifyTheme>;

  // Theme Asset Management
  loadThemeAssets(
    accessToken: string,
    shop: string,
    themeId: string,
  ): Promise<LoadThemeAssetsResponse>;

  getThemeAsset(
    accessToken: string,
    shop: string,
    themeId: string,
    assetKey: string,
  ): Promise<ThemeAsset>;

  updateThemeAsset(
    accessToken: string,
    shop: string,
    assetData: UpdateThemeAssetInput,
  ): Promise<ThemeAsset>;

  deleteThemeAsset(
    accessToken: string,
    shop: string,
    themeId: string,
    assetKey: string,
  ): Promise<void>;

  // Theme Settings Management
  getThemeSettings(accessToken: string, shop: string, themeId: string): Promise<ThemeSettings>;

  updateThemeSettings(
    accessToken: string,
    shop: string,
    themeId: string,
    settings: ThemeSettings,
  ): Promise<ThemeSettings>;
}
