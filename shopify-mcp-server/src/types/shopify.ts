/**
 * Comprehensive TypeScript definitions for Shopify Admin API 2024-04
 *
 * This file contains all the type definitions needed for interacting with
 * the Shopify Admin API, including products, orders, customers, inventory,
 * and all other commerce entities.
 */

// ============================================================================
// Base Types and Utilities
// ============================================================================

/** Base interface for all Shopify resources with common fields */
export interface ShopifyResource {
  /** Globally unique identifier */
  id: string;
  /** Legacy numeric ID (deprecated but still used in some contexts) */
  legacyResourceId?: string;
  /** ISO 8601 timestamp of creation */
  createdAt: string;
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
}

/** Shopify Money type for currency amounts */
export interface Money {
  /** Amount in the currency's smallest unit (e.g., cents for USD) */
  amount: string;
  /** ISO 4217 currency code */
  currencyCode: string;
}

/** Image resource used across multiple entities */
export interface Image {
  id?: string;
  /** Image URL */
  url: string;
  /** Alt text for accessibility */
  altText?: string;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
}

/** Metafield for storing custom data */
export interface Metafield {
  id?: string;
  /** Namespace for grouping metafields */
  namespace: string;
  /** Key identifier within the namespace */
  key: string;
  /** The stored value */
  value: string;
  /** Value type (string, integer, json_string, etc.) */
  type: MetafieldType;
  /** Description of the metafield */
  description?: string;
}

export type MetafieldType =
  | "string"
  | "integer"
  | "json_string"
  | "boolean"
  | "date"
  | "date_time"
  | "url"
  | "single_line_text_field"
  | "multi_line_text_field"
  | "rich_text_field"
  | "file_reference"
  | "page_reference"
  | "product_reference"
  | "variant_reference"
  | "collection_reference";

// ============================================================================
// Product Types
// ============================================================================

export interface Product extends ShopifyResource {
  /** Product title */
  title: string;
  /** Product description (HTML) */
  description: string;
  /** URL handle for the product */
  handle: string;
  /** Product vendor/brand */
  vendor: string;
  /** Product type/category */
  productType: string;
  /** Product status */
  status: ProductStatus;
  /** Array of product tags */
  tags: string[];
  /** Product images */
  images: ProductImage[];
  /** Product variants */
  variants: ProductVariant[];
  /** Product options (size, color, etc.) */
  options: ProductOption[];
  /** SEO information */
  seo: SEO;
  /** Custom metafields */
  metafields: Metafield[];
  /** Whether the product is published */
  publishedAt?: string;
  /** Template suffix for custom templates */
  templateSuffix?: string;
  /** Whether the product requires shipping */
  requiresSellingPlan: boolean;
  /** Selling plan groups */
  sellingPlanGroups: SellingPlanGroup[];
}

export type ProductStatus = "ACTIVE" | "ARCHIVED" | "DRAFT";

export interface ProductImage extends Image {
  /** Position in the image list */
  position: number;
  /** Associated variant IDs */
  variantIds: string[];
}

export interface ProductVariant extends ShopifyResource {
  /** Variant title */
  title: string;
  /** SKU (Stock Keeping Unit) */
  sku?: string;
  /** Barcode */
  barcode?: string;
  /** Variant price */
  price: Money;
  /** Compare at price (original price) */
  compareAtPrice?: Money;
  /** Position in variant list */
  position: number;
  /** Inventory policy */
  inventoryPolicy: InventoryPolicy;
  /** Inventory quantity */
  inventoryQuantity: number;
  /** Whether inventory is tracked */
  inventoryManagement: InventoryManagement;
  /** Fulfillment service */
  fulfillmentService: string;
  /** Weight value */
  weight?: number;
  /** Weight unit */
  weightUnit: WeightUnit;
  /** Whether the variant requires shipping */
  requiresShipping: boolean;
  /** Whether the variant is taxable */
  taxable: boolean;
  /** Tax code */
  taxCode?: string;
  /** Selected options (e.g., {"Size": "Large", "Color": "Red"}) */
  selectedOptions: SelectedOption[];
  /** Variant image */
  image?: Image;
  /** Custom metafields */
  metafields: Metafield[];
}

export interface SelectedOption {
  /** Option name */
  name: string;
  /** Option value */
  value: string;
}

export interface ProductOption {
  id?: string;
  /** Option name (e.g., "Size", "Color") */
  name: string;
  /** Position in options list */
  position: number;
  /** Available values for this option */
  values: string[];
}

export type InventoryPolicy = "DENY" | "CONTINUE";
export type InventoryManagement = "SHOPIFY" | "NOT_MANAGED" | "FULFILLMENT_SERVICE";
export type WeightUnit = "GRAMS" | "KILOGRAMS" | "OUNCES" | "POUNDS";

export interface SEO {
  /** SEO title */
  title?: string;
  /** SEO description */
  description?: string;
}

export interface SellingPlanGroup {
  id: string;
  name: string;
  merchantCode: string;
  description?: string;
  options: string[];
  sellingPlans: SellingPlan[];
}

export interface SellingPlan {
  id: string;
  name: string;
  description?: string;
  options: string[];
  priceAdjustments: PriceAdjustment[];
  recurringDeliveries: boolean;
}

export interface PriceAdjustment {
  adjustmentType: "PERCENTAGE" | "FIXED_AMOUNT" | "PRICE";
  adjustmentValue: Money | number;
}

// ============================================================================
// Order Types
// ============================================================================

export interface Order extends ShopifyResource {
  /** Order name/number */
  name: string;
  /** Order number */
  orderNumber: number;
  /** Order status */
  fulfillmentStatus: FulfillmentStatus;
  /** Financial status */
  financialStatus: FinancialStatus;
  /** Customer information */
  customer?: Customer;
  /** Billing address */
  billingAddress?: Address;
  /** Shipping address */
  shippingAddress?: Address;
  /** Line items */
  lineItems: LineItem[];
  /** Shipping lines */
  shippingLines: ShippingLine[];
  /** Tax lines */
  taxLines: TaxLine[];
  /** Discount applications */
  discountApplications: DiscountApplication[];
  /** Subtotal price */
  subtotalPrice: Money;
  /** Total tax */
  totalTax: Money;
  /** Total price */
  totalPrice: Money;
  /** Currency */
  currencyCode: string;
  /** Order tags */
  tags: string[];
  /** Order note */
  note?: string;
  /** Custom attributes */
  customAttributes: Attribute[];
  /** Fulfillments */
  fulfillments: Fulfillment[];
  /** Transactions */
  transactions: Transaction[];
  /** Risk assessments */
  risks: OrderRisk[];
  /** Whether the order was processed */
  processedAt?: string;
  /** Cancelled at timestamp */
  cancelledAt?: string;
  /** Cancellation reason */
  cancelReason?: string;
  /** Closed at timestamp */
  closedAt?: string;
}

export type FulfillmentStatus = "FULFILLED" | "PARTIAL" | "RESTOCKED" | "UNFULFILLED";

export type FinancialStatus =
  | "AUTHORIZED"
  | "PAID"
  | "PARTIALLY_PAID"
  | "PARTIALLY_REFUNDED"
  | "PENDING"
  | "REFUNDED"
  | "VOIDED";

export interface LineItem {
  id: string;
  /** Product variant */
  variant?: ProductVariant;
  /** Product */
  product?: Product;
  /** Quantity ordered */
  quantity: number;
  /** Line item price */
  originalUnitPrice: Money;
  /** Discounted unit price */
  discountedUnitPrice: Money;
  /** Total discount */
  totalDiscount: Money;
  /** Line item title */
  title: string;
  /** Variant title */
  variantTitle?: string;
  /** SKU */
  sku?: string;
  /** Vendor */
  vendor?: string;
  /** Whether the item requires shipping */
  requiresShipping: boolean;
  /** Whether the item is taxable */
  taxable: boolean;
  /** Tax lines */
  taxLines: TaxLine[];
  /** Custom attributes */
  customAttributes: Attribute[];
  /** Fulfillment service */
  fulfillmentService?: string;
}

export interface ShippingLine {
  id?: string;
  /** Shipping method title */
  title: string;
  /** Shipping price */
  price: Money;
  /** Discounted price */
  discountedPrice: Money;
  /** Carrier identifier */
  carrierIdentifier?: string;
  /** Requested fulfillment service */
  requestedFulfillmentService?: string;
  /** Tax lines */
  taxLines: TaxLine[];
  /** Discount allocations */
  discountAllocations: DiscountAllocation[];
}

export interface TaxLine {
  /** Tax title */
  title: string;
  /** Tax rate */
  rate: number;
  /** Tax price */
  price: Money;
  /** Channel liable for tax */
  channelLiable: boolean;
}

export interface DiscountApplication {
  /** Discount type */
  type: DiscountApplicationType;
  /** Discount title */
  title: string;
  /** Discount description */
  description?: string;
  /** Discount value */
  value: Money | number;
  /** Value type */
  valueType: DiscountValueType;
  /** Allocation method */
  allocationMethod: DiscountAllocationMethod;
  /** Target selection */
  targetSelection: DiscountTargetSelection;
  /** Target type */
  targetType: DiscountTargetType;
}

export type DiscountApplicationType = "AUTOMATIC" | "DISCOUNT_CODE" | "MANUAL" | "SCRIPT";

export type DiscountValueType = "FIXED_AMOUNT" | "PERCENTAGE";

export type DiscountAllocationMethod = "ACROSS" | "EACH" | "ONE";

export type DiscountTargetSelection = "ALL" | "ENTITLED" | "EXPLICIT";

export type DiscountTargetType = "LINE_ITEM" | "SHIPPING_LINE";

export interface DiscountAllocation {
  /** Allocated amount */
  allocatedAmount: Money;
  /** Discount application */
  discountApplication: DiscountApplication;
}

export interface Attribute {
  /** Attribute key */
  key: string;
  /** Attribute value */
  value: string;
}

// ============================================================================
// Customer Types
// ============================================================================

export interface Customer extends ShopifyResource {
  /** Customer email */
  email: string;
  /** First name */
  firstName?: string;
  /** Last name */
  lastName?: string;
  /** Display name */
  displayName: string;
  /** Phone number */
  phone?: string;
  /** Customer state */
  state: CustomerState;
  /** Customer tags */
  tags: string[];
  /** Default address */
  defaultAddress?: Address;
  /** All addresses */
  addresses: Address[];
  /** Orders count */
  ordersCount: number;
  /** Total spent */
  totalSpent: Money;
  /** Average order value */
  averageOrderValue?: Money;
  /** Last order date */
  lastOrderAt?: string;
  /** Customer note */
  note?: string;
  /** Whether customer accepts marketing */
  acceptsMarketing: boolean;
  /** Marketing opt-in level */
  marketingOptInLevel?: MarketingOptInLevel;
  /** Email marketing consent */
  emailMarketingConsent?: MarketingConsent;
  /** SMS marketing consent */
  smsMarketingConsent?: MarketingConsent;
  /** Custom metafields */
  metafields: Metafield[];
  /** Tax exempt status */
  taxExempt: boolean;
  /** Tax exemptions */
  taxExemptions: string[];
  /** Verified email */
  verifiedEmail: boolean;
}

export type CustomerState = "DECLINED" | "DISABLED" | "ENABLED" | "INVITED";

export type MarketingOptInLevel = "CONFIRMED_OPT_IN" | "NOT_OPTED_IN" | "SINGLE_OPT_IN" | "UNKNOWN";

export interface MarketingConsent {
  /** Marketing state */
  marketingState: MarketingState;
  /** Opt-in level */
  marketingOptInLevel?: MarketingOptInLevel;
  /** Consent updated at */
  consentUpdatedAt?: string;
}

export type MarketingState = "NOT_SUBSCRIBED" | "PENDING" | "SUBSCRIBED";

export interface Address {
  id?: string;
  /** First name */
  firstName?: string;
  /** Last name */
  lastName?: string;
  /** Company name */
  company?: string;
  /** Address line 1 */
  address1?: string;
  /** Address line 2 */
  address2?: string;
  /** City */
  city?: string;
  /** Province/State */
  province?: string;
  /** Province/State code */
  provinceCode?: string;
  /** Country */
  country?: string;
  /** Country code */
  countryCode?: string;
  /** ZIP/Postal code */
  zip?: string;
  /** Phone number */
  phone?: string;
  /** Whether this is the default address */
  default?: boolean;
}

// ============================================================================
// Fulfillment Types
// ============================================================================

export interface Fulfillment extends ShopifyResource {
  /** Fulfillment status */
  status: FulfillmentStatus;
  /** Tracking company */
  trackingCompany?: string;
  /** Tracking numbers */
  trackingNumbers: string[];
  /** Tracking URLs */
  trackingUrls: string[];
  /** Shipment status */
  shipmentStatus?: ShipmentStatus;
  /** Line items being fulfilled */
  fulfillmentLineItems: FulfillmentLineItem[];
  /** Location where fulfillment originated */
  location?: Location;
  /** Service used for fulfillment */
  service?: string;
  /** Fulfillment orders */
  fulfillmentOrders: FulfillmentOrder[];
}

export type ShipmentStatus =
  | "CONFIRMED"
  | "DELIVERED"
  | "FAILURE"
  | "IN_TRANSIT"
  | "LABEL_PRINTED"
  | "LABEL_PURCHASED"
  | "OUT_FOR_DELIVERY"
  | "READY_FOR_PICKUP";

export interface FulfillmentLineItem {
  id: string;
  /** Line item being fulfilled */
  lineItem: LineItem;
  /** Quantity being fulfilled */
  quantity: number;
}

export interface FulfillmentOrder extends ShopifyResource {
  /** Fulfillment order status */
  status: FulfillmentOrderStatus;
  /** Request status */
  requestStatus: FulfillmentOrderRequestStatus;
  /** Line items */
  lineItems: FulfillmentOrderLineItem[];
  /** Destination address */
  destination: Address;
  /** Delivery method */
  deliveryMethod?: DeliveryMethod;
  /** Assigned location */
  assignedLocation: Location;
  /** Supported actions */
  supportedActions: FulfillmentOrderAction[];
}

export type FulfillmentOrderStatus = "CANCELLED" | "CLOSED" | "INCOMPLETE" | "OPEN" | "SCHEDULED";

export type FulfillmentOrderRequestStatus =
  | "ACCEPTED"
  | "CANCELLATION_ACCEPTED"
  | "CANCELLATION_REJECTED"
  | "CANCELLATION_REQUESTED"
  | "CLOSED"
  | "REJECTED"
  | "SUBMITTED"
  | "UNSUBMITTED";

export interface FulfillmentOrderLineItem {
  id: string;
  /** Line item */
  lineItem: LineItem;
  /** Quantity to fulfill */
  quantity: number;
  /** Remaining quantity */
  remainingQuantity: number;
}

export interface DeliveryMethod {
  id: string;
  /** Method type */
  methodType: DeliveryMethodType;
  /** Minimum delivery date */
  minDeliveryDateTime?: string;
  /** Maximum delivery date */
  maxDeliveryDateTime?: string;
}

export type DeliveryMethodType = "LOCAL" | "NONE" | "PICK_UP" | "RETAIL" | "SHIPPING";

export type FulfillmentOrderAction =
  | "CANCEL"
  | "CREATE_FULFILLMENT"
  | "EXTERNAL"
  | "HOLD"
  | "MOVE"
  | "RELEASE_HOLD"
  | "REQUEST_CANCELLATION"
  | "REQUEST_FULFILLMENT";

// ============================================================================
// Inventory Types
// ============================================================================

export interface InventoryLevel {
  id: string;
  /** Available quantity */
  available: number;
  /** Location */
  location: Location;
  /** Inventory item */
  item: InventoryItem;
  /** Updated at timestamp */
  updatedAt: string;
}

export interface InventoryItem extends ShopifyResource {
  /** SKU */
  sku?: string;
  /** Whether inventory is tracked */
  tracked: boolean;
  /** Country code of origin */
  countryCodeOfOrigin?: string;
  /** Harmonized system code */
  harmonizedSystemCode?: string;
  /** Province code of origin */
  provinceCodeOfOrigin?: string;
  /** Requires shipping */
  requiresShipping: boolean;
  /** Unit cost */
  unitCost?: Money;
  /** Country harmonized system codes */
  countryHarmonizedSystemCodes: CountryHarmonizedSystemCode[];
}

export interface CountryHarmonizedSystemCode {
  /** Country code */
  countryCode: string;
  /** Harmonized system code */
  harmonizedSystemCode: string;
}

export interface Location extends ShopifyResource {
  /** Location name */
  name: string;
  /** Address */
  address: Address;
  /** Whether location is active */
  isActive: boolean;
  /** Whether location ships inventory */
  shipsInventory: boolean;
  /** Whether location fulfills online orders */
  fulfillsOnlineOrders: boolean;
  /** Location type */
  locationType?: string;
}

// ============================================================================
// Collection Types
// ============================================================================

export interface Collection extends ShopifyResource {
  /** Collection title */
  title: string;
  /** Collection description */
  description: string;
  /** URL handle */
  handle: string;
  /** Collection image */
  image?: Image;
  /** SEO information */
  seo: SEO;
  /** Collection type */
  sortOrder: CollectionSortOrder;
  /** Template suffix */
  templateSuffix?: string;
  /** Products count */
  productsCount: number;
  /** Whether collection is published */
  publishedAt?: string;
  /** Custom metafields */
  metafields: Metafield[];
  /** Collection rules (for smart collections) */
  rules?: CollectionRule[];
  /** Rule set (for smart collections) */
  ruleSet?: CollectionRuleSet;
}

export type CollectionSortOrder =
  | "ALPHA_ASC"
  | "ALPHA_DESC"
  | "BEST_SELLING"
  | "CREATED"
  | "CREATED_DESC"
  | "MANUAL"
  | "PRICE_ASC"
  | "PRICE_DESC";

export interface CollectionRule {
  /** Rule column */
  column: CollectionRuleColumn;
  /** Rule relation */
  relation: CollectionRuleRelation;
  /** Rule condition */
  condition: string;
}

export type CollectionRuleColumn =
  | "IS_PRICE_REDUCED"
  | "PRODUCT_METAFIELD"
  | "TAG"
  | "TITLE"
  | "TYPE"
  | "VARIANT_COMPARE_AT_PRICE"
  | "VARIANT_INVENTORY"
  | "VARIANT_PRICE"
  | "VARIANT_TITLE"
  | "VARIANT_WEIGHT"
  | "VENDOR";

export type CollectionRuleRelation =
  | "CONTAINS"
  | "ENDS_WITH"
  | "EQUALS"
  | "GREATER_THAN"
  | "IS_NOT_SET"
  | "IS_SET"
  | "LESS_THAN"
  | "NOT_CONTAINS"
  | "NOT_EQUALS"
  | "STARTS_WITH";

export type CollectionRuleSet = "ALL_CONDITIONS" | "ANY_CONDITION";

// ============================================================================
// Transaction Types
// ============================================================================

export interface Transaction extends ShopifyResource {
  /** Transaction amount */
  amount: Money;
  /** Authorization code */
  authorization?: string;
  /** Transaction kind */
  kind: TransactionKind;
  /** Transaction status */
  status: TransactionStatus;
  /** Gateway used */
  gateway: string;
  /** Error code */
  errorCode?: TransactionErrorCode;
  /** Message from gateway */
  message?: string;
  /** Test transaction */
  test: boolean;
  /** Parent transaction */
  parentTransaction?: Transaction;
  /** Receipt */
  receipt?: string;
  /** Currency exchange adjustment */
  currencyExchangeAdjustment?: CurrencyExchangeAdjustment;
  /** Fees */
  fees: TransactionFee[];
  /** Payment details */
  paymentDetails?: PaymentDetails;
  /** Processed at timestamp */
  processedAt?: string;
}

export type TransactionKind =
  | "AUTHORIZATION"
  | "CAPTURE"
  | "CHANGE"
  | "EMV_AUTHORIZATION"
  | "REFUND"
  | "SALE"
  | "VOID";

export type TransactionStatus = "ERROR" | "FAILURE" | "PENDING" | "SUCCESS";

export type TransactionErrorCode =
  | "CALL_ISSUER"
  | "CARD_DECLINED"
  | "EXPIRED_CARD"
  | "GENERIC_ERROR"
  | "INCORRECT_ADDRESS"
  | "INCORRECT_CVC"
  | "INCORRECT_NUMBER"
  | "INCORRECT_ZIP"
  | "INSUFFICIENT_FUNDS"
  | "INVALID_CVC"
  | "INVALID_EXPIRY_DATE"
  | "INVALID_NUMBER"
  | "PICK_UP_CARD"
  | "PROCESSING_ERROR";

export interface CurrencyExchangeAdjustment {
  /** Adjustment amount */
  adjustment: Money;
  /** Original amount */
  originalAmount: Money;
  /** Final amount */
  finalAmount: Money;
}

export interface TransactionFee {
  /** Fee amount */
  amount: Money;
  /** Fee type */
  type: string;
  /** Flat fee */
  flatFee: Money;
  /** Rate */
  rate: number;
}

export interface PaymentDetails {
  /** AVS result code */
  avsResultCode?: string;
  /** Credit card bin */
  creditCardBin?: string;
  /** Credit card company */
  creditCardCompany?: string;
  /** Credit card number (masked) */
  creditCardNumber?: string;
  /** CVV result code */
  cvvResultCode?: string;
}

// ============================================================================
// Risk Assessment Types
// ============================================================================

export interface OrderRisk {
  /** Risk level */
  level: RiskLevel;
  /** Risk message */
  message: string;
  /** Recommendation */
  recommendation: RiskRecommendation;
  /** Risk score */
  score: number;
  /** Source of risk assessment */
  source: RiskSource;
  /** Whether risk was caused by buyer */
  causeCancel: boolean;
  /** Display flag */
  display: boolean;
}

export type RiskLevel = "HIGH" | "LOW" | "MEDIUM";

export type RiskRecommendation = "ACCEPT" | "CANCEL" | "INVESTIGATE";

export type RiskSource = "EXTERNAL" | "GATEWAY" | "PROTECTION" | "USER";

// ============================================================================
// Discount Types
// ============================================================================

export interface DiscountCode extends ShopifyResource {
  /** Discount code */
  code: string;
  /** Usage count */
  usageCount: number;
  /** Usage limit */
  usageLimit?: number;
  /** Usage limit per customer */
  usageLimitPerCustomer?: number;
  /** Starts at timestamp */
  startsAt?: string;
  /** Ends at timestamp */
  endsAt?: string;
  /** Discount class */
  discountClass: DiscountClass;
  /** Applies once per customer */
  appliesOncePerCustomer: boolean;
  /** Applies to resource */
  appliesTo: DiscountAppliesTo;
  /** Async usage count */
  asyncUsageCount: number;
  /** Codes count */
  codesCount?: number;
  /** Summary */
  summary: string;
  /** Title */
  title: string;
}

export type DiscountClass = "ORDER" | "PRODUCT" | "SHIPPING";

export type DiscountAppliesTo = "ALL" | "SPECIFIC";

// ============================================================================
// Webhook Types
// ============================================================================

export interface Webhook extends ShopifyResource {
  /** Webhook topic */
  topic: WebhookTopic;
  /** Callback URL */
  callbackUrl: string;
  /** Format */
  format: WebhookFormat;
  /** Fields to include */
  fields?: string[];
  /** Metafield namespaces */
  metafieldNamespaces?: string[];
  /** Private metafield namespaces */
  privateMetafieldNamespaces?: string[];
  /** API version */
  apiVersion: string;
}

export type WebhookTopic =
  | "APP_UNINSTALLED"
  | "CARTS_CREATE"
  | "CARTS_UPDATE"
  | "CHECKOUTS_CREATE"
  | "CHECKOUTS_DELETE"
  | "CHECKOUTS_UPDATE"
  | "COLLECTION_LISTINGS_ADD"
  | "COLLECTION_LISTINGS_REMOVE"
  | "COLLECTION_LISTINGS_UPDATE"
  | "COLLECTIONS_CREATE"
  | "COLLECTIONS_DELETE"
  | "COLLECTIONS_UPDATE"
  | "CUSTOMER_GROUPS_CREATE"
  | "CUSTOMER_GROUPS_DELETE"
  | "CUSTOMER_GROUPS_UPDATE"
  | "CUSTOMERS_CREATE"
  | "CUSTOMERS_DELETE"
  | "CUSTOMERS_DISABLE"
  | "CUSTOMERS_ENABLE"
  | "CUSTOMERS_UPDATE"
  | "DRAFT_ORDERS_CREATE"
  | "DRAFT_ORDERS_DELETE"
  | "DRAFT_ORDERS_UPDATE"
  | "FULFILLMENT_EVENTS_CREATE"
  | "FULFILLMENT_EVENTS_DELETE"
  | "FULFILLMENTS_CREATE"
  | "FULFILLMENTS_UPDATE"
  | "INVENTORY_ITEMS_CREATE"
  | "INVENTORY_ITEMS_DELETE"
  | "INVENTORY_ITEMS_UPDATE"
  | "INVENTORY_LEVELS_CONNECT"
  | "INVENTORY_LEVELS_DISCONNECT"
  | "INVENTORY_LEVELS_UPDATE"
  | "LOCATIONS_CREATE"
  | "LOCATIONS_DELETE"
  | "LOCATIONS_UPDATE"
  | "ORDER_TRANSACTIONS_CREATE"
  | "ORDERS_CANCELLED"
  | "ORDERS_CREATE"
  | "ORDERS_DELETE"
  | "ORDERS_FULFILLED"
  | "ORDERS_PAID"
  | "ORDERS_PARTIALLY_FULFILLED"
  | "ORDERS_UPDATED"
  | "PRODUCT_LISTINGS_ADD"
  | "PRODUCT_LISTINGS_REMOVE"
  | "PRODUCT_LISTINGS_UPDATE"
  | "PRODUCTS_CREATE"
  | "PRODUCTS_DELETE"
  | "PRODUCTS_UPDATE"
  | "REFUNDS_CREATE"
  | "SHOP_UPDATE"
  | "THEMES_CREATE"
  | "THEMES_DELETE"
  | "THEMES_PUBLISH"
  | "THEMES_UPDATE";

export type WebhookFormat = "JSON" | "XML";

// ============================================================================
// Shop Types
// ============================================================================

export interface Shop {
  id: string;
  /** Shop name */
  name: string;
  /** Shop email */
  email: string;
  /** Shop domain */
  domain: string;
  /** Myshopify domain */
  myshopifyDomain: string;
  /** Shop owner */
  shopOwner: string;
  /** Primary currency */
  currencyCode: string;
  /** Enabled currencies */
  enabledCurrencies: string[];
  /** Shop description */
  description?: string;
  /** Phone number */
  phone?: string;
  /** Address */
  address1?: string;
  /** City */
  city?: string;
  /** Province */
  province?: string;
  /** Province code */
  provinceCode?: string;
  /** Country */
  country?: string;
  /** Country code */
  countryCode?: string;
  /** Country name */
  countryName?: string;
  /** ZIP code */
  zip?: string;
  /** Latitude */
  latitude?: number;
  /** Longitude */
  longitude?: number;
  /** Timezone */
  timezone: string;
  /** IANATimezone */
  ianaTimezone: string;
  /** Weight unit */
  weightUnit: WeightUnit;
  /** Plan name */
  planName?: string;
  /** Plan display name */
  planDisplayName?: string;
  /** Whether password is enabled */
  passwordEnabled: boolean;
  /** Primary locale */
  primaryLocale: string;
  /** Customer email */
  customerEmail?: string;
  /** Setup required */
  setupRequired: boolean;
  /** Has storefront */
  hasStorefront: boolean;
  /** Has discounts */
  hasDiscounts: boolean;
  /** Has gift cards */
  hasGiftCards: boolean;
  /** Taxes included */
  taxesIncluded: boolean;
  /** Tax shipping */
  taxShipping: boolean;
  /** County taxes */
  countyTaxes: boolean;
  /** Created at */
  createdAt: string;
  /** Updated at */
  updatedAt: string;
}

// ============================================================================
// Error Types
// ============================================================================

export interface UserError {
  /** Error field */
  field?: string[];
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
}

export interface ShopifyError {
  /** Error message */
  message: string;
  /** Error locations */
  locations?: ErrorLocation[];
  /** Error path */
  path?: (string | number)[];
  /** Error extensions */
  extensions?: {
    code?: string;
    exception?: {
      stacktrace?: string[];
    };
  };
}

export interface ErrorLocation {
  /** Line number */
  line: number;
  /** Column number */
  column: number;
}

// ============================================================================
// GraphQL Response Types
// ============================================================================

export interface GraphQLResponse<T = any> {
  /** Response data */
  data?: T;
  /** Response errors */
  errors?: ShopifyError[];
  /** Response extensions */
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

export interface Connection<T> {
  /** Edges containing nodes */
  edges: Edge<T>[];
  /** Page info */
  pageInfo: PageInfo;
}

export interface Edge<T> {
  /** Cursor for pagination */
  cursor: string;
  /** Node data */
  node: T;
}

export interface PageInfo {
  /** Whether there are more pages */
  hasNextPage: boolean;
  /** Whether there are previous pages */
  hasPreviousPage: boolean;
  /** Start cursor */
  startCursor?: string;
  /** End cursor */
  endCursor?: string;
}

// ============================================================================
// Input Types for Mutations
// ============================================================================

export interface ProductInput {
  title: string;
  description?: string;
  handle?: string;
  vendor?: string;
  productType?: string;
  status?: ProductStatus;
  tags?: string[];
  images?: ProductImageInput[];
  variants?: ProductVariantInput[];
  options?: ProductOptionInput[];
  seo?: SEOInput;
  metafields?: MetafieldInput[];
  templateSuffix?: string;
  requiresSellingPlan?: boolean;
}

export interface ProductImageInput {
  altText?: string;
  src?: string;
}

export interface ProductVariantInput {
  title?: string;
  sku?: string;
  barcode?: string;
  price?: string;
  compareAtPrice?: string;
  position?: number;
  inventoryPolicy?: InventoryPolicy;
  inventoryQuantity?: number;
  inventoryManagement?: InventoryManagement;
  fulfillmentService?: string;
  weight?: number;
  weightUnit?: WeightUnit;
  requiresShipping?: boolean;
  taxable?: boolean;
  taxCode?: string;
  options?: string[];
  imageId?: string;
  metafields?: MetafieldInput[];
}

export interface ProductOptionInput {
  name: string;
  position?: number;
  values: string[];
}

export interface SEOInput {
  title?: string;
  description?: string;
}

export interface MetafieldInput {
  namespace: string;
  key: string;
  value: string;
  type: MetafieldType;
  description?: string;
}

export interface CustomerInput {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  tags?: string[];
  addresses?: AddressInput[];
  note?: string;
  acceptsMarketing?: boolean;
  metafields?: MetafieldInput[];
  taxExempt?: boolean;
  taxExemptions?: string[];
}

export interface AddressInput {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
}

export interface OrderInput {
  lineItems: LineItemInput[];
  customer?: CustomerInput;
  billingAddress?: AddressInput;
  shippingAddress?: AddressInput;
  shippingLine?: ShippingLineInput;
  note?: string;
  tags?: string[];
  customAttributes?: AttributeInput[];
  financialStatus?: FinancialStatus;
  sendReceipt?: boolean;
  sendFulfillmentReceipt?: boolean;
  inventoryBehaviour?: InventoryBehaviour;
}

export interface LineItemInput {
  variantId?: string;
  productId?: string;
  quantity: number;
  title?: string;
  price?: string;
  sku?: string;
  vendor?: string;
  requiresShipping?: boolean;
  taxable?: boolean;
  customAttributes?: AttributeInput[];
}

export interface ShippingLineInput {
  title: string;
  price: string;
  carrierIdentifier?: string;
  requestedFulfillmentService?: string;
}

export interface AttributeInput {
  key: string;
  value: string;
}

export type InventoryBehaviour =
  | "BYPASS"
  | "DECREMENT_IGNORING_POLICY"
  | "DECREMENT_OBEYING_POLICY";

// ============================================================================
// Bulk Operation Types
// ============================================================================

export interface BulkOperation extends ShopifyResource {
  /** Operation status */
  status: BulkOperationStatus;
  /** Error code */
  errorCode?: BulkOperationErrorCode;
  /** Completed at timestamp */
  completedAt?: string;
  /** Objects count */
  objectCount: string;
  /** File size */
  fileSize?: string;
  /** Download URL */
  url?: string;
  /** Partial data URL */
  partialDataUrl?: string;
  /** Root object count */
  rootObjectCount: string;
  /** Query */
  query: string;
  /** Type */
  type: BulkOperationType;
}

export type BulkOperationStatus =
  | "CANCELED"
  | "CANCELING"
  | "COMPLETED"
  | "CREATED"
  | "EXPIRED"
  | "FAILED"
  | "RUNNING";

export type BulkOperationErrorCode = "ACCESS_DENIED" | "INTERNAL_SERVER_ERROR" | "TIMEOUT";

export type BulkOperationType = "MUTATION" | "QUERY";

// ============================================================================
// Export all types
// ============================================================================

export * from "./shopify";
