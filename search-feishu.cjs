const fs = require('fs');
function search(dir, pattern, depth) {
  depth = depth || 0;
  if(depth > 4) return;
  try {
    const items = fs.readdirSync(dir, {withFileTypes: true});
    for(const item of items) {
      const path = dir + '/' + item.name;
      if(item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules')
        search(path, pattern, depth+1);
      else if(item.name.endsWith('.ts') || item.name.endsWith('.js')) {
        const content = fs.readFileSync(path, 'utf8');
        if(content.includes(pattern)) {
          const lines = content.split('\n');
          lines.forEach((l, i) => {
            if(l.includes(pattern))
              console.log(path + ':' + (i+1) + ': ' + l.substring(0, 200));
          });
        }
      }
    }
  } catch(e) {}
}
search('E:/openclaw/src', 'feishu');
