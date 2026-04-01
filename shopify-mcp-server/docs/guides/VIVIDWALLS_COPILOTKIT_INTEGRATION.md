# VividWalls CopilotKit Shopify Integration

This document describes the complete VividWalls AI assistant integration for Shopify stores, enabling customers to receive personalized art recommendations and support through an intelligent chat interface.

## Overview

The VividWalls CopilotKit integration adds an AI-powered sales assistant to your Shopify store that can:

- **Analyze room photos** and recommend suitable artwork
- **Provide detailed product information** about VividWalls collections
- **Assist with sizing and framing recommendations**
- **Offer personalized art suggestions** based on customer preferences
- **Handle customer support questions** about limited editions and ordering
- **Connect to VividWalls MAS system** via n8n workflows for advanced automation

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Shopify       │    │   n8n Webhook    │    │  VividWalls     │
│   Store         │◄──►│   Endpoint       │◄──►│  MAS System     │
│                 │    │                  │    │                 │
│ • CopilotKit    │    │ • AI Processing  │    │ • Product DB    │
│ • Chat Widget   │    │ • Image Analysis │    │ • Supabase      │
│ • Context Data  │    │ • Recommendations│    │ • Analytics     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Features

### 🎨 **Product Page Integration**

- Contextual product information and recommendations
- Size and framing guidance
- Limited edition availability
- Compatible artwork suggestions

### 🏠 **Collection Browsing**

- Style-based filtering and recommendations
- Price range guidance
- Room-specific suggestions
- Popular and trending items

### 📸 **Image Analysis**

- Room photo upload and analysis
- Color palette extraction
- Style matching
- Placement recommendations

### 🛒 **Cart Integration**

- Gallery wall suggestions
- Compatibility checks between selected pieces
- Upselling recommendations
- Shipping and delivery information

### 💬 **Customer Support**

- Order status inquiries
- Return and exchange guidance
- Care instructions
- Custom framing options

## Installation

### Prerequisites

1. **Shopify Private App** with the following permissions:
   - `read_themes` and `write_themes`
   - `read_products` and `read_collections`
   - `read_customers` (optional, for personalization)

2. **Environment Variables**:

   ```bash
   SHOPIFY_ACCESS_TOKEN=shpat_your_access_token_here
   MYSHOPIFY_DOMAIN=your-store.myshopify.com
   ```

3. **n8n Webhook Endpoint** (configured in the VividWalls MAS system)

### Quick Setup

1. **Clone and Setup**:

   ```bash
   cd mcp/shopify-mcp-server
   npm install
   npm run build
   ```

2. **Run the Integration Script**:
   ```bash
   ./scripts/setup-vividwalls-integration.sh
   ```

### Manual Setup

If you prefer manual installation:

1. **Build the MCP Server**:

   ```bash
   npm run build
   ```

2. **Run the Integration**:
   ```bash
   node scripts/create-vividwalls-copilot-integration.js
   ```

## Configuration

### n8n Webhook Configuration

The integration connects to your VividWalls n8n workflow at:

```
http://157.230.13.13:5678/webhook/vividwalls-chat
```

**Webhook Payload Structure**:

```json
{
  "chatInput": "Customer message",
  "sessionId": "session_1234567890_abc123",
  "pageContext": {
    "url": "https://store.com/products/artwork-name",
    "type": "product",
    "productData": { ... },
    "collectionData": { ... }
  },
  "timestamp": "2025-05-30T12:00:00.000Z",
  "imageData": "data:image/jpeg;base64,..." // Optional
}
```

### Shopify Metafields

For enhanced functionality, configure these product metafields:

```yaml
vividwalls.art_style: "Abstract" | "Landscape" | "Portrait" | etc.
vividwalls.room_type: "Living Room" | "Bedroom" | "Office" | etc.
vividwalls.color_palette: ["blue", "white", "gold"]
vividwalls.dimensions: "24x36 inches"
vividwalls.limited_edition: true | false
vividwalls.edition_number: 15
vividwalls.total_editions: 100
vividwalls.artist_info: "Artist name and bio"
vividwalls.framing_options: ["Black Frame", "White Frame", "No Frame"]
vividwalls.material_info: "Canvas print on premium material"
```

## UI Components

### Floating Action Button (FAB)

```css
.copilot-fab {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-radius: 50px;
  padding: 12px 20px;
  /* Additional styles... */
}
```

### Chat Interface

- **Header**: Branded with VividWalls styling
- **Messages**: User and AI message bubbles
- **Recommendations**: Product cards with images and links
- **Input**: Text input with drag-and-drop image support
- **Loading**: Animated typing indicator

### Responsive Design

- Desktop: 380px × 600px floating window
- Tablet: Full width, 70vh height
- Mobile: 80vh height with optimized touch targets

## Advanced Features

### Context-Aware Responses

The AI assistant adapts its responses based on:

- **Page Type**: Different suggestions for product vs. collection pages
- **Product Data**: Specific information about viewed items
- **Customer History**: Previous purchases and preferences (if available)
- **Session Context**: Maintains conversation continuity

### Image Analysis Workflow

1. **Upload**: Customer drags/drops room photo
2. **Processing**: Image sent to n8n webhook
3. **Analysis**: AI analyzes colors, style, lighting
4. **Recommendations**: Returns compatible artwork suggestions
5. **Display**: Shows curated recommendations with reasoning

### Personalization

- **Session Persistence**: Maintains conversation across page views
- **Customer Recognition**: Adapts to logged-in customer preferences
- **Purchase History**: References previous orders for suggestions
- **Behavioral Learning**: Improves recommendations over time

## Customization

### Styling

Modify the CSS variables in the integration:

```css
:root {
  --vividwalls-primary: #667eea;
  --vividwalls-secondary: #764ba2;
  --vividwalls-background: #ffffff;
  --vividwalls-text: #333333;
  --vividwalls-border: #e1e5e9;
}
```

### Chat Suggestions

Customize context-specific suggestions by modifying the snippet files:

```javascript
window.VividWallsProductSuggestions = [
  "Tell me more about this artwork",
  "What size should I choose for my space?",
  // Add your custom suggestions...
];
```

### Welcome Messages

Personalize welcome messages for different page types:

```javascript
const getWelcomeMessage = () => {
  if (context.type === "product") {
    return {
      title: "Your custom product page greeting",
      // ...
    };
  }
  // ...
};
```

## Analytics and Monitoring

### Events Tracked

- **Chat Opens**: When customers open the assistant
- **Messages Sent**: Customer interactions
- **Image Uploads**: Room photo analysis requests
- **Recommendations Clicked**: Product recommendation engagement
- **Conversions**: Purchases following assistant interactions

### n8n Monitoring

Monitor the integration through your n8n dashboard:

1. **Webhook Activity**: View incoming requests
2. **Response Times**: Monitor AI processing speed
3. **Error Rates**: Track failed requests
4. **Usage Patterns**: Analyze peak interaction times

### Shopify Analytics

Track performance through Shopify's analytics:

- **Custom Events**: Assistant-driven page views
- **Conversion Funnels**: Assistant → Product → Purchase
- **Customer Segments**: Assistant users vs. regular visitors

## Troubleshooting

### Common Issues

**Chat Widget Not Appearing**:

- Verify theme.liquid was modified correctly
- Check browser console for JavaScript errors
- Ensure React libraries are loading

**n8n Webhook Errors**:

- Test webhook URL accessibility
- Verify payload format
- Check n8n workflow configuration

**Styling Conflicts**:

- Review CSS specificity
- Check for theme style overrides
- Test on different devices/browsers

### Debug Mode

Enable debug logging:

```javascript
window.VividWallsDebug = true;
```

This will log all interactions to the browser console.

### Performance Optimization

**Lazy Loading**:

- React libraries load on-demand
- Images use lazy loading
- Minimize initial bundle size

**Caching**:

- Session data persisted in sessionStorage
- Repeated recommendations cached
- Optimized API calls

## API Reference

### Chat Message Format

**Request**:

```json
{
  "chatInput": "string",
  "sessionId": "string",
  "pageContext": {
    "url": "string",
    "type": "product|collection|cart|home",
    "productData": { ... },
    "collectionData": { ... }
  },
  "imageData": "string" // Base64 encoded image
}
```

**Response**:

```json
{
  "response": "AI response text",
  "recommendations": [
    {
      "title": "Artwork Title",
      "description": "Brief description",
      "image": "https://...",
      "url": "/products/artwork-handle",
      "price": "$299"
    }
  ],
  "visualizations": [ ... ] // Optional 3D room visualizations
}
```

## Security Considerations

- **Input Validation**: All user inputs are sanitized
- **Rate Limiting**: Prevents spam and abuse
- **CORS Configuration**: Restricted to your domain
- **Session Management**: Secure session handling
- **Image Upload**: Size and type restrictions

## Browser Compatibility

- **Minimum Requirements**: ES6 support, Fetch API
- **Supported Browsers**: Chrome 60+, Firefox 55+, Safari 12+, Edge 79+
- **Fallbacks**: Graceful degradation for older browsers
- **Mobile Support**: iOS Safari 12+, Chrome Mobile 60+

## Performance Metrics

- **Initial Load**: < 2s on 3G
- **Chat Response**: < 3s average
- **Image Analysis**: < 10s for room photos
- **Memory Usage**: < 10MB typical
- **Bundle Size**: < 500KB compressed

## Support and Maintenance

### Regular Updates

- **Security Patches**: Monthly security reviews
- **Feature Updates**: Quarterly enhancements
- **Performance Optimization**: Ongoing monitoring
- **Bug Fixes**: Weekly maintenance window

### Getting Help

- **Documentation**: This guide and inline comments
- **Support Email**: admin@vividwalls.com
- **GitHub Issues**: For bug reports and feature requests
- **Community Forum**: For general questions

---

**Last Updated**: May 30, 2025  
**Version**: 1.0.0  
**Author**: VividWalls Development Team
