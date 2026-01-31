import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PATCH_DIR = path.join(process.cwd(), 'patches');
const COMMAND = process.argv[2];
const ARG = process.argv[3];

if (!fs.existsSync(PATCH_DIR)) {
    fs.mkdirSync(PATCH_DIR);
}

function run(cmd) {
    try {
        console.log(`> ${cmd}`);
        execSync(cmd, { stdio: 'inherit' });
        return true;
    } catch (e) {
        console.error(`Command failed: ${cmd}`);
        return false;
    }
}

// Helper to find data dir (simplified version of resolveConfigDir)
function getDataDir() {
    // Try to load .env manually since we might not have dotenv loaded
    const envPath = path.join(process.cwd(), '.env');
    let envStateDir = null;
    if (fs.existsSync(envPath)) {
        try {
            const envContent = fs.readFileSync(envPath, 'utf-8');
            const match = envContent.match(/^OPENCLAW_STATE_DIR=(.*)$/m);
            if (match && match[1]) {
                envStateDir = match[1].trim();
            }
        } catch (e) { }
    }

    const envDir = process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || envStateDir;
    if (envDir) return path.resolve(envDir);
    const home = process.env.HOME || process.env.USERPROFILE;
    return path.join(home, ".openclaw");
}

function updateManifest(filename, description) {
    const dataDir = getDataDir();
    const manifestPath = path.join(dataDir, "patch_manifest.json");

    // Ensure dir exists
    if (!fs.existsSync(dataDir)) {
        try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { }
    }

    let manifest = { patches: [], lastUpdated: Date.now() };
    if (fs.existsSync(manifestPath)) {
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch (e) {
            console.warn("Manifest corrupted, resetting.");
        }
    }

    // Remove old entry
    manifest.patches = manifest.patches.filter(p => p.id !== filename);

    // Add new
    manifest.patches.push({
        id: filename,
        description: description || "Auto-generated patch",
        appliedAt: Date.now(),
        filesAffected: ["(see git diff)"]
    });
    manifest.lastUpdated = Date.now();

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[Manifest] Recorded patch to ${manifestPath}`);
}

function savePatch(name) {
    if (!name) {
        console.error('Usage: node scripts/local-patch.mjs save <patch-name>');
        process.exit(1);
    }
    const filename = `local-${name}.patch`;
    const filepath = path.join(PATCH_DIR, filename);
    // Using git diff to capture all current changes
    const cmd = `git diff > "${filepath}"`;
    // execSync with redirection might be shell dependent, but typical on windows/linux

    try {
        console.log(`Saving patch to ${filename}...`);
        execSync(cmd, { stdio: 'inherit', shell: true });

        // Update manifest
        updateManifest(filename, "User created patch");

        console.log(`Success! Saved to patches/${filename}`);
    } catch (e) {
        console.error("Failed to save patch.");
    }
}

function applyPatches() {
    const files = fs.readdirSync(PATCH_DIR).filter(f => f.endsWith('.patch'));
    if (files.length === 0) {
        console.log('No patch files found in patches/');
        return;
    }

    console.log(`Found ${files.length} patches.`);
    for (const file of files) {
        const filepath = path.join(PATCH_DIR, file);
        console.log(`\nApplying ${file}...`);

        // Check first
        const checkCmd = `git apply --check "${filepath}"`;
        const canApply = run(checkCmd);

        if (canApply) {
            run(`git apply "${filepath}"`);
            console.log(`✓ Applied ${file}`);
        } else {
            console.warn(`! Skipped ${file} (conflicts or already applied)`);
        }
    }
}

switch (COMMAND) {
    case 'save':
        savePatch(ARG);
        break;
    case 'apply':
        applyPatches();
        break;
    default:
        console.log(`
OpenClaw Local Patch Manager

Usage:
  node scripts/local-patch.mjs save <name>   # Save current changes as a patch
  node scripts/local-patch.mjs apply         # Apply all patches in patches/ directory
`);
        break;
}
