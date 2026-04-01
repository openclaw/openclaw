# Capabilities — Ecommerce Manager

## Core Tools

- `bdi_cycle`, `belief_get`, `belief_update`, `goal_create`, `goal_evaluate`
- `desire_create`, `desire_evaluate`, `intention_commit`, `intention_reconsider`
- `plan_generate`, `plan_execute_step`, `htn_decompose`
- `agent_message` — Inter-agent ACL communication
- `decision_request` — Escalate to stakeholder
- `cbr_retrieve`, `cbr_store` — Case-based learning
- `fact_assert`, `fact_query` — Knowledge management
- `memory_store_item`, `memory_recall` — Memory operations
- `reason` — Multi-method reasoning

## Shopify Admin Tools

### Products

- `shopify_get_products` — Search/list products with title filter and pagination
- `shopify_get_products_by_collection` — Products in a collection
- `shopify_get_products_by_ids` — Retrieve specific products by GID
- `shopify_get_variants_by_ids` — Retrieve variants with product details

### Customers

- `shopify_get_customers` — List customers with pagination
- `shopify_tag_customer` — Add tags to a customer

### Orders

- `shopify_get_orders` — Query orders with filters, sorting, pagination
- `shopify_get_order` — Single order details
- `shopify_create_draft_order` — Create draft orders
- `shopify_complete_draft_order` — Finalize draft orders

### Discounts

- `shopify_create_discount` — Create discount codes (percentage or fixed)

### Store

- `shopify_get_shop` — Basic shop info
- `shopify_get_shop_details` — Detailed shop info (shipping countries)
- `shopify_get_collections` — List product collections
- `shopify_manage_webhook` — Subscribe/unsubscribe/find webhooks
- `shopify_custom_graphql` — Execute custom GraphQL queries

### Pages

- `shopify_get_pages` — List content pages
- `shopify_get_page` — Single page details
- `shopify_create_page` — Create content page
- `shopify_update_page` — Update content page
- `shopify_delete_page` — Delete content page

### Navigation

- `shopify_get_navigation_menus` — List navigation menus
- `shopify_create_navigation_menu` — Create navigation menu
- `shopify_get_menu_items` — List menu items
- `shopify_create_menu_item` — Add menu item

### Themes

- `shopify_get_themes` — List installed themes
- `shopify_get_theme` — Theme details
- `shopify_create_theme` — Create/upload theme
- `shopify_duplicate_theme` — Duplicate existing theme
- `shopify_get_theme_assets` — List theme files
- `shopify_get_theme_asset` — Read theme file
- `shopify_update_theme_asset` — Create/update theme file
- `shopify_get_theme_settings` — Read theme settings
- `shopify_update_theme_settings` — Update theme settings

## Linked Skills

- `shopify-development` — Shopify Liquid, theme development, storefront API patterns
