import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const projectRoot = '/home/louis16sb/.openclaw/workspace/riscv-claw/src';

function walk(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            walk(fullPath);
        } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes('.toSorted(')) {
                console.log(`Fixing toSorted in ${fullPath}`);
                // Replace array.toSorted(...) with [...array].sort(...)
                // This is a simple regex that handles basic cases
                content = content.replace(/([a-zA-Z0-9_$.?\[\]]+)\.toSorted\(([^)]*)\)/g, '[...$1].sort($2)');
                fs.writeFileSync(fullPath, content);
            }
            if (content.includes('.toSorted()')) {
                 console.log(`Fixing toSorted() in ${fullPath}`);
                 content = content.replace(/([a-zA-Z0-9_$.?\[\]]+)\.toSorted\(\)/g, '[...$1].sort()');
                 fs.writeFileSync(fullPath, content);
            }
        }
    }
}

walk(projectRoot);
console.log('Done fixing toSorted!');
