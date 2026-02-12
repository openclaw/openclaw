| name      | description                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| design-ui | Design user interfaces in PenPot programmatically. This skill should be used when the user asks to "design a UI", "create a screen", "build a layout", "make a mockup", "design a page", "create a component", or anything involving visual design in PenPot. |

## How It Works

```
User describes a UI
       │
       ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ List projects│────▶│ Create/find  │────▶│  Design UI  │
│ & find where │     │  a file      │     │  (batch)    │
│ to work      │     │              │     │             │
└─────────────┘     └──────────────┘     └─────────────┘
                                                │
                                                ▼
                                         ┌─────────────┐
                                         │  Add library │
                                         │  colors &    │
                                         │  typography  │
                                         └─────────────┘
```

## Workflow

1. **Find the project** — Use `penpot_list_projects` to find the team and project to work in.

2. **Create or find a file** — Use `penpot_create_file` to create a new design file, or `penpot_inspect_file` to read an existing one. Note the `revn` (revision number) — every update increments it.

3. **Design the UI** — Use `penpot_design_ui` to create the full layout in one call. Describe the UI as a component tree.

4. **Add library items** — Use `penpot_manage_library` to add colors and typography styles for consistency.

## Component Tree Format

The `penpot_design_ui` tool accepts a JSON array of shape trees. Each shape has:

| Field             | Required | Description                                          |
| ----------------- | -------- | ---------------------------------------------------- |
| `type`            | Yes      | `rect`, `circle`, `text`, `frame`, or `group`        |
| `name`            | Yes      | Human-readable shape name                            |
| `x`, `y`          | Yes      | Position (use 0,0 for flex-layout children)          |
| `width`, `height` | Yes      | Dimensions in pixels                                 |
| `fills`           | No       | Array of `{"fill-color": "#hex", "fill-opacity": 1}` |
| `strokes`         | No       | Array of stroke definitions                          |
| `r1`-`r4`         | No       | Border radius (rect only)                            |
| `fillColor`       | No       | Shorthand fill for frames                            |
| `layout`          | No       | Flex/grid layout (frames only)                       |
| `children`        | No       | Nested shapes (frames/groups only)                   |
| `paragraphs`      | No       | Text content (text shapes only)                      |

### Layout Properties (for frames)

```json
{
  "layout": "flex",
  "layout-flex-dir": "column",
  "layout-justify-content": "center",
  "layout-align-items": "center",
  "layout-gap": { "row-gap": 16, "column-gap": 0 },
  "layout-padding": { "p1": 24, "p2": 24, "p3": 24, "p4": 24 }
}
```

### Text Content

```json
{
  "paragraphs": [
    {
      "spans": [
        {
          "text": "Hello World",
          "fontSize": "16",
          "fontWeight": "400",
          "fillColor": "#000000",
          "fontFamily": "Inter"
        }
      ],
      "textAlign": "center"
    }
  ]
}
```

## Revision Tracking

Every `update-file` call (design_ui, add_page, update_file, manage_library) increments the file revision. Always use the latest `revn` — if you get it wrong the call will fail. Track it:

- After `penpot_create_file`: use the returned `revn` (usually 0)
- After each update: increment by 1

## Design Best Practices

- Use frames as containers with flex layout for responsive designs.
- Set `x: 0, y: 0` for children inside flex-layout frames (the layout engine positions them).
- Use common mobile sizes: 375x812 (iPhone), 390x844 (iPhone 14), 360x800 (Android).
- Use common desktop sizes: 1440x900, 1920x1080.
- Build component hierarchies: Screen > Sections > Elements.
- Apply consistent spacing via layout gap and padding.
- Always add library colors and typography after designing for reusability.

## Related Tools

| Tool                    | When to use                          |
| ----------------------- | ------------------------------------ |
| `penpot_list_projects`  | Find where to create files           |
| `penpot_create_file`    | Start a new design                   |
| `penpot_inspect_file`   | Read existing file structure         |
| `penpot_add_page`       | Add pages to a file                  |
| `penpot_design_ui`      | Create complete UI layouts (primary) |
| `penpot_update_file`    | Modify/delete individual shapes      |
| `penpot_manage_library` | Add colors and typography            |
