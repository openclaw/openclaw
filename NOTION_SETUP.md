# Notion Database Setup Guide

This guide will help you set up the required Notion databases for the Thinker Cafe website.

## Prerequisites

1. Create a Notion account at https://notion.so
2. Create a new Notion integration at https://developers.notion.com/my-integrations
3. Copy the integration token and add it to your `.env.local` file as `NOTION_TOKEN`

## Database Structures

### 1. Products Database

Create a new database with the following properties:

- **Name** (Title) - Product name in English
- **NameZh** (Rich Text) - Product name in Chinese
- **Description** (Rich Text) - Product description in English
- **DescriptionZh** (Rich Text) - Product description in Chinese
- **Price** (Rich Text) - Product price (e.g., "$24.99")
- **Image** (Files & Media) - Product image
- **Rating** (Number) - Product rating (0-5)
- **Category** (Select) - Product category (Coffee Beans, Ready to Drink, Equipment)
- **CategoryZh** (Rich Text) - Category name in Chinese
- **Featured** (Checkbox) - Whether the product is featured

### 2. About Content Database

Create a new database with the following properties:

- **Title** (Title) - Section title in English
- **TitleZh** (Rich Text) - Section title in Chinese
- **Content** (Rich Text) - Section content in English
- **ContentZh** (Rich Text) - Section content in Chinese
- **Section** (Select) - Section type (Story, Values, Mission, Vision, Team)
- **Image** (Files & Media) - Section image (optional)
- **Order** (Number) - Display order

### 3. Contact Submissions Database

Create a new database with the following properties:

- **Name** (Title) - Contact person's name
- **Email** (Email) - Contact email address
- **Subject** (Select) - Inquiry subject (General Inquiry, Product Information, Partnership Opportunities, Feedback & Suggestions, Customer Support, Other)
- **Message** (Rich Text) - Contact message
- **Language** (Select) - Preferred language (en, zh)
- **Timestamp** (Date) - Submission timestamp
- **Status** (Select) - Processing status (New, In Progress, Resolved)

## Integration Setup

1. Share each database with your Notion integration:
   - Open each database in Notion
   - Click the "Share" button in the top right
   - Click "Invite" and search for your integration name
   - Select your integration and click "Invite"

2. Copy the database IDs:
   - The database ID is the string of characters in the URL after the last slash and before the question mark
   - Example: `https://notion.so/myworkspace/a8aec43384f447ed84390e8e42c2e089?v=...`
   - Database ID: `a8aec43384f447ed84390e8e42c2e089`

3. Add the database IDs to your `.env.local` file:
   \`\`\`
   NOTION_PRODUCTS_DATABASE_ID=your_products_database_id
   NOTION_ABOUT_DATABASE_ID=your_about_database_id
   NOTION_CONTACT_DATABASE_ID=your_contact_database_id
   \`\`\`

## Sample Data

### Products Database Sample Entries

1. **Signature Blend**
   - NameZh: 招牌綜合
   - Description: Our carefully crafted signature blend with notes of chocolate and caramel
   - DescriptionZh: 精心調配的招牌綜合咖啡，帶有巧克力和焦糖香氣
   - Price: $24.99
   - Rating: 4.8
   - Category: Coffee Beans
   - CategoryZh: 咖啡豆
   - Featured: ✓

2. **Ethiopian Single Origin**
   - NameZh: 衣索比亞單品
   - Description: Bright and fruity single origin with floral notes
   - DescriptionZh: 明亮果香的單品咖啡，帶有花香調性
   - Price: $28.99
   - Rating: 4.9
   - Category: Coffee Beans
   - CategoryZh: 咖啡豆
   - Featured: ✓

### About Content Database Sample Entries

1. **Company Story**
   - Title: Our Story
   - TitleZh: 我們的故事
   - Content: Thinker Cafe was born from a simple observation: the best ideas often emerge over a great cup of coffee...
   - ContentZh: 思考者咖啡源於一個簡單的觀察：最好的想法往往在一杯好咖啡中產生...
   - Section: Story
   - Order: 1

## Testing

After setting up the databases and environment variables, restart your development server and test the following endpoints:

- `GET /api/products` - Should return all products
- `GET /api/products/featured` - Should return featured products only
- `GET /api/about` - Should return about content
- `POST /api/contact` - Should create a new contact submission

The website should now dynamically load content from your Notion databases!
