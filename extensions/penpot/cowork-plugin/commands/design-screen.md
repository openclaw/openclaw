| description                                     | argument-hint                           |
| ----------------------------------------------- | --------------------------------------- |
| Design a complete screen or UI layout in PenPot | \<description of the screen to design\> |

## What to do

Design a complete screen in PenPot based on the user's description.

### Steps

1. Use `penpot_list_projects` to find available projects. Pick the most relevant one, or ask the user which project to use if there are multiple.

2. Use `penpot_create_file` with a descriptive name based on what the user asked for (e.g., "Login Screen", "Dashboard Layout", "Settings Page").

3. Use `penpot_design_ui` to create the full layout as a component tree. Design a thoughtful, modern UI:
   - Use a root frame sized for the target device (mobile: 375x812, desktop: 1440x900)
   - Apply flex layout for responsive structure
   - Use a clean color palette (grays for backgrounds, blue for primary actions)
   - Include proper spacing via layout gap and padding
   - Name every shape descriptively

4. Use `penpot_manage_library` to add the color palette and typography styles used in the design.

5. Report what was created and provide the PenPot workspace URL: `{baseUrl}/#/workspace/{fileId}`

### Design principles

- **Hierarchy**: Use size, weight, and color to establish visual hierarchy
- **Spacing**: Consistent gaps (8, 12, 16, 24, 32px) and padding
- **Typography**: 2-3 font sizes max per screen, clear weight contrast
- **Color**: Limited palette — 1 primary, 1-2 neutrals, 1 accent
- **Containers**: Use frames with fills and border radius to create cards, inputs, buttons

### Input

$ARGUMENTS — the user's description of what screen or UI to design.
