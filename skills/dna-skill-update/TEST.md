# Testing Guide

## Pre-Publication Testing

Before publishing, test all functionality locally:

## 1. Script Permissions

```bash
cd /tmp/dna-update-publish

# Check all scripts are executable
ls -la *.sh

# If not, fix:
chmod +x *.sh
```

## 2. Dry Run Test

```bash
# Test dry run (should show what would be backed up)
./backup-dna-dryrun.sh

# Expected output:
# - Workspace detection
# - Size calculations
# - List of files that would be created
# - No actual files created
```

## 3. Backup Test

```bash
# Create test backup
./backup-dna-full.sh

# Verify backup created
ls -lh ~/.dna-backups/

# Check backup contents
LATEST=$(ls -t ~/.dna-backups/ | head -1)
ls -lh ~/.dna-backups/$LATEST/
cat ~/.dna-backups/$LATEST/BACKUP_INFO.txt
```

## 4. Validation Test

```bash
# Test validation
./validate-setup.sh

# Expected output:
# - Config check
# - Workspace analysis
# - Credentials check
# - Git state
```

## 5. Upstream Check Test

```bash
# Test upstream check
./check-upstream.sh

# Expected output:
# - Current state
# - Fetch upstream
# - Commit comparison
```

## 6. Restore Test (Careful!)

```bash
# Only test if you have a backup
# This will overwrite current config!

# Create safety backup first
cp ~/.dna/dna.json ~/.dna/dna.json.test-backup

# Test restore (will ask for confirmation)
./restore-dna.sh ~/.dna-backups/<backup-dir>

# Restore safety backup
mv ~/.dna/dna.json.test-backup ~/.dna/dna.json
```

## 7. Package Validation

```bash
cd /tmp/dna-update-publish

# Validate package.json
npm run validate 2>/dev/null || cat package.json | jq '.'

# Check .clawdhub.json
cat .clawdhub.json | jq '.'

# Test npm pack
npm pack

# Inspect tarball
tar -tzf dna-skill-update-1.0.0.tgz
```

## 8. Documentation Check

```bash
# Check all documentation files exist
for file in README.md SKILL.md UPDATE_CHECKLIST.md QUICK_REFERENCE.md PUBLISH.md; do
  if [ -f "$file" ]; then
    echo "✓ $file exists ($(wc -l < $file) lines)"
  else
    echo "✗ $file missing!"
  fi
done

# Check for broken links (manual review)
grep -r "](/" *.md
```

## 9. Security Check

```bash
# Check for personal data
echo "Checking for personal data..."
grep -r "pascal\|/Users/pascal\|clawd-family\|cyberheld\|120363" . --include="*.sh" --include="*.md" --include="*.json" || echo "✓ No personal data found"

# Check for sensitive patterns
grep -r "sk-\|token\|password\|secret" . --include="*.sh" --include="*.md" --include="*.json" || echo "✓ No secrets found"
```

## 10. Installation Test

```bash
# Test installation from tarball
mkdir -p /tmp/test-install
cd /tmp/test-install

# Extract
tar -xzf /tmp/dna-update-publish/dna-skill-update-1.0.0.tgz
cd package

# Make executable
chmod +x *.sh

# Test scripts
./backup-dna-dryrun.sh
./validate-setup.sh
./check-upstream.sh
```

## Testing Checklist

- [ ] All scripts are executable
- [ ] Dry run works without creating files
- [ ] Backup creates valid backup directory
- [ ] Backup includes all expected files
- [ ] Workspaces are detected dynamically
- [ ] Validation script runs without errors
- [ ] Upstream check connects to GitHub
- [ ] Restore works (tested safely)
- [ ] package.json is valid JSON
- [ ] .clawdhub.json is valid JSON
- [ ] No personal data in any file
- [ ] No secrets or tokens
- [ ] All documentation files present
- [ ] npm pack succeeds
- [ ] Installation from tarball works

## Expected Test Results

### Dry Run Output
```
🔍 DNA Backup Dry Run
===========================
This is a DRY RUN - no files will be created or modified

📁 Would create backup at:
   ~/.dna-backups/pre-update-YYYYMMDD-HHMMSS

✓ Config file: ~/.dna/dna.json
✓ Detected workspaces from config
✓ Would backup X workspace(s)
✨ Dry run complete!
```

### Validation Output
```
🔍 DNA Setup Validation
============================

✅ Config file exists
✅ Workspace(s) ready
✅ Credentials directory exists
✅ Git repository found
```

### Package Structure
```
package/
├── backup-dna-dryrun.sh
├── backup-dna-full.sh
├── restore-dna.sh
├── validate-setup.sh
├── check-upstream.sh
├── config.json
├── README.md
├── SKILL.md
├── UPDATE_CHECKLIST.md
├── QUICK_REFERENCE.md
└── LICENSE
```

## Post-Test Cleanup

```bash
# Remove test installations
rm -rf /tmp/test-install

# Keep one test backup for reference
LATEST=$(ls -t ~/.dna-backups/ | head -1)
echo "Test backup preserved: ~/.dna-backups/$LATEST"

# Remove npm tarball
rm /tmp/dna-update-publish/*.tgz
```

## Ready for Publication?

If all tests pass:
1. Review PUBLISH.md
2. Create GitHub repository
3. Publish to npm
4. Submit to ClawdHub

## Troubleshooting Tests

### Script won't execute
```bash
chmod +x *.sh
```

### Backup fails
```bash
# Check config exists
ls -la ~/.dna/dna.json

# Check permissions
ls -la ~/.dna/
```

### Workspace detection fails
```bash
# Check config structure
jq '.routing.agents' ~/.dna/dna.json
```

### npm pack fails
```bash
# Validate JSON
cat package.json | jq '.'

# Check required fields
jq '{name, version, author, license}' package.json
```

---

**Author**: Pascal Schott (@pasogott)  
**License**: MIT
