# PenPot Design Examples

## Login Screen (Mobile)

```json
{
  "type": "frame",
  "name": "Login Screen",
  "x": 0,
  "y": 0,
  "width": 375,
  "height": 812,
  "fillColor": "#F9FAFB",
  "layout": {
    "layout": "flex",
    "layout-flex-dir": "column",
    "layout-justify-content": "center",
    "layout-align-items": "center",
    "layout-gap": { "row-gap": 16, "column-gap": 0 },
    "layout-padding": { "p1": 40, "p2": 24, "p3": 40, "p4": 24 }
  },
  "children": [
    {
      "type": "text",
      "name": "App Title",
      "x": 0,
      "y": 0,
      "width": 200,
      "height": 40,
      "paragraphs": [
        {
          "spans": [
            {
              "text": "MyApp",
              "fontSize": "32",
              "fontWeight": "700",
              "fillColor": "#1F2937",
              "fontFamily": "Inter"
            }
          ],
          "textAlign": "center"
        }
      ]
    },
    {
      "type": "text",
      "name": "Subtitle",
      "x": 0,
      "y": 0,
      "width": 250,
      "height": 24,
      "paragraphs": [
        {
          "spans": [
            {
              "text": "Sign in to continue",
              "fontSize": "16",
              "fontWeight": "400",
              "fillColor": "#6B7280",
              "fontFamily": "Inter"
            }
          ],
          "textAlign": "center"
        }
      ]
    },
    {
      "type": "frame",
      "name": "Form",
      "x": 0,
      "y": 0,
      "width": 327,
      "height": 200,
      "fillColor": "#FFFFFF",
      "layout": {
        "layout": "flex",
        "layout-flex-dir": "column",
        "layout-gap": { "row-gap": 12, "column-gap": 0 },
        "layout-padding": { "p1": 24, "p2": 24, "p3": 24, "p4": 24 }
      },
      "children": [
        {
          "type": "rect",
          "name": "Email Input",
          "x": 0,
          "y": 0,
          "width": 279,
          "height": 48,
          "r1": 8,
          "r2": 8,
          "r3": 8,
          "r4": 8,
          "fills": [{ "fill-color": "#F3F4F6", "fill-opacity": 1 }]
        },
        {
          "type": "rect",
          "name": "Password Input",
          "x": 0,
          "y": 0,
          "width": 279,
          "height": 48,
          "r1": 8,
          "r2": 8,
          "r3": 8,
          "r4": 8,
          "fills": [{ "fill-color": "#F3F4F6", "fill-opacity": 1 }]
        },
        {
          "type": "rect",
          "name": "Sign In Button",
          "x": 0,
          "y": 0,
          "width": 279,
          "height": 48,
          "r1": 8,
          "r2": 8,
          "r3": 8,
          "r4": 8,
          "fills": [{ "fill-color": "#3B82F6", "fill-opacity": 1 }]
        }
      ]
    },
    {
      "type": "text",
      "name": "Forgot Password",
      "x": 0,
      "y": 0,
      "width": 200,
      "height": 20,
      "paragraphs": [
        {
          "spans": [
            {
              "text": "Forgot password?",
              "fontSize": "14",
              "fontWeight": "400",
              "fillColor": "#3B82F6",
              "fontFamily": "Inter"
            }
          ],
          "textAlign": "center"
        }
      ]
    }
  ]
}
```

## Card Component

```json
{
  "type": "frame",
  "name": "Card",
  "x": 0,
  "y": 0,
  "width": 320,
  "height": 200,
  "fillColor": "#FFFFFF",
  "r1": 12,
  "r2": 12,
  "r3": 12,
  "r4": 12,
  "layout": {
    "layout": "flex",
    "layout-flex-dir": "column",
    "layout-gap": { "row-gap": 8, "column-gap": 0 },
    "layout-padding": { "p1": 16, "p2": 16, "p3": 16, "p4": 16 }
  },
  "children": [
    {
      "type": "rect",
      "name": "Thumbnail",
      "x": 0,
      "y": 0,
      "width": 288,
      "height": 100,
      "r1": 8,
      "r2": 8,
      "r3": 8,
      "r4": 8,
      "fills": [{ "fill-color": "#E5E7EB", "fill-opacity": 1 }]
    },
    {
      "type": "text",
      "name": "Title",
      "x": 0,
      "y": 0,
      "width": 288,
      "height": 24,
      "paragraphs": [
        {
          "spans": [
            {
              "text": "Card Title",
              "fontSize": "18",
              "fontWeight": "600",
              "fillColor": "#111827",
              "fontFamily": "Inter"
            }
          ]
        }
      ]
    },
    {
      "type": "text",
      "name": "Description",
      "x": 0,
      "y": 0,
      "width": 288,
      "height": 32,
      "paragraphs": [
        {
          "spans": [
            {
              "text": "A short description of the card content goes here.",
              "fontSize": "14",
              "fontWeight": "400",
              "fillColor": "#6B7280",
              "fontFamily": "Inter"
            }
          ]
        }
      ]
    }
  ]
}
```

## Navigation Bar

```json
{
  "type": "frame",
  "name": "Nav Bar",
  "x": 0,
  "y": 0,
  "width": 375,
  "height": 56,
  "fillColor": "#FFFFFF",
  "layout": {
    "layout": "flex",
    "layout-flex-dir": "row",
    "layout-justify-content": "space-between",
    "layout-align-items": "center",
    "layout-padding": { "p1": 0, "p2": 16, "p3": 0, "p4": 16 }
  },
  "children": [
    {
      "type": "text",
      "name": "Back",
      "x": 0,
      "y": 0,
      "width": 60,
      "height": 24,
      "paragraphs": [
        {
          "spans": [
            {
              "text": "Back",
              "fontSize": "16",
              "fontWeight": "400",
              "fillColor": "#3B82F6",
              "fontFamily": "Inter"
            }
          ]
        }
      ]
    },
    {
      "type": "text",
      "name": "Title",
      "x": 0,
      "y": 0,
      "width": 150,
      "height": 24,
      "paragraphs": [
        {
          "spans": [
            {
              "text": "Page Title",
              "fontSize": "18",
              "fontWeight": "600",
              "fillColor": "#111827",
              "fontFamily": "Inter"
            }
          ],
          "textAlign": "center"
        }
      ]
    },
    {
      "type": "circle",
      "name": "Avatar",
      "x": 0,
      "y": 0,
      "width": 32,
      "height": 32,
      "fills": [{ "fill-color": "#D1D5DB", "fill-opacity": 1 }]
    }
  ]
}
```

## Color Palette & Typography

After designing, add library items:

**Colors:**

```json
[
  { "name": "Primary", "color": "#3B82F6" },
  { "name": "Secondary", "color": "#8B5CF6" },
  { "name": "Success", "color": "#10B981" },
  { "name": "Warning", "color": "#F59E0B" },
  { "name": "Error", "color": "#EF4444" },
  { "name": "Background", "color": "#F9FAFB" },
  { "name": "Surface", "color": "#FFFFFF" },
  { "name": "Text Primary", "color": "#111827" },
  { "name": "Text Secondary", "color": "#6B7280" }
]
```

**Typography:**

```json
[
  {
    "name": "Heading 1",
    "fontFamily": "Inter",
    "fontSize": "32",
    "fontWeight": "700",
    "lineHeight": "1.2"
  },
  {
    "name": "Heading 2",
    "fontFamily": "Inter",
    "fontSize": "24",
    "fontWeight": "600",
    "lineHeight": "1.3"
  },
  {
    "name": "Body",
    "fontFamily": "Inter",
    "fontSize": "16",
    "fontWeight": "400",
    "lineHeight": "1.5"
  },
  {
    "name": "Caption",
    "fontFamily": "Inter",
    "fontSize": "14",
    "fontWeight": "400",
    "lineHeight": "1.4"
  },
  {
    "name": "Button",
    "fontFamily": "Inter",
    "fontSize": "16",
    "fontWeight": "600",
    "lineHeight": "1"
  }
]
```
