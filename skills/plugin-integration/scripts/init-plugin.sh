#!/bin/bash

# Initialize a new OpenClaw plugin with the correct structure
# Creates openclaw.plugin.json (not manifest.json)

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <plugin-name> [output-dir]"
  echo "Example: $0 my-plugin"
  echo "         $0 my-plugin ~/.openclaw/plugins"
  exit 1
fi

PLUGIN_NAME="$1"
OUTPUT_DIR="${2:-.}"

# Validate plugin name
if [[ ! "$PLUGIN_NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "Error: Plugin name must be lowercase letters, numbers, and hyphens only."
  echo "Example: my-plugin, hello-world, data-processor"
  exit 1
fi

PLUGIN_DIR="$OUTPUT_DIR/$PLUGIN_NAME"

if [ -d "$PLUGIN_DIR" ]; then
  echo "Error: Directory $PLUGIN_DIR already exists."
  exit 1
fi

echo "🦞 Creating OpenClaw plugin: $PLUGIN_NAME"
echo ""

# Create directory structure
mkdir -p "$PLUGIN_DIR"

# Create openclaw.plugin.json (correct manifest for OpenClaw plugins)
cat > "$PLUGIN_DIR/openclaw.plugin.json" << EOF
{
  "name": "$PLUGIN_NAME",
  "version": "1.0.0",
  "description": "A new OpenClaw plugin",
  "main": "index.js",
  "author": "",
  "license": "MIT",
  "keywords": ["openclaw", "plugin"],
  "openclaw": {
    "minVersion": "1.0.0",
    "permissions": []
  }
}
EOF

# Create main entry point
cat > "$PLUGIN_DIR/index.js" << 'EOF'
/**
 * OpenClaw Plugin Entry Point
 * 
 * This file is loaded when the plugin is activated.
 */

module.exports = {
  name: '{{PLUGIN_NAME}}',
  
  /**
   * Called when the plugin is loaded
   */
  async onLoad(context) {
    this.context = context;
    console.log(`{{PLUGIN_NAME}} plugin loaded`);
  },
  
  /**
   * Called when the plugin is activated
   */
  async onActivate() {
    console.log(`{{PLUGIN_NAME}} plugin activated`);
  },
  
  /**
   * Called when the plugin is deactivated
   */
  async onDeactivate() {
    console.log(`{{PLUGIN_NAME}} plugin deactivated`);
  },
  
  /**
   * Register commands or tools
   */
  register(registry) {
    // Example: registry.command('hello', this.hello.bind(this));
    // Example: registry.tool('myTool', this.myTool.bind(this));
  },
  
  /**
   * Example command implementation
   */
  hello(args) {
    return `Hello from {{PLUGIN_NAME}}!`;
  }
};
EOF

# Replace placeholder with actual plugin name
sed -i "s/{{PLUGIN_NAME}}/$PLUGIN_NAME/g" "$PLUGIN_DIR/index.js"

# Create README
cat > "$PLUGIN_DIR/README.md" << EOF
# $PLUGIN_NAME

An OpenClaw plugin.

## Installation

\`\`\`bash
openclaw plugins install $PLUGIN_NAME
\`\`\`

## Usage

\`\`\`
openclaw $PLUGIN_NAME
\`\`\`

## Development

1. Edit \`index.js\` to add your plugin logic
2. Update \`openclaw.plugin.json\` with your plugin details
3. Test with \`openclaw plugins validate $PLUGIN_NAME\`

## License

MIT
EOF

# Create .gitignore
cat > "$PLUGIN_DIR/.gitignore" << 'EOF'
node_modules/
*.log
.env
.DS_Store
EOF

echo "✅ Plugin created successfully!"
echo ""
echo "📁 Created files:"
echo "   $PLUGIN_DIR/"
echo "   ├── openclaw.plugin.json  (manifest)"
echo "   ├── index.js              (entry point)"
echo "   ├── README.md             (documentation)"
echo "   └── .gitignore             (git ignore file)"
echo ""
echo "Next steps:"
echo "   1. Edit $PLUGIN_DIR/openclaw.plugin.json"
echo "   2. Implement your plugin in $PLUGIN_DIR/index.js"
echo "   3. Validate: ~/.openclaw/skills/plugin-integration/scripts/validate-plugin.sh $PLUGIN_DIR"
echo "   4. Install: openclaw plugins install $PLUGIN_DIR"