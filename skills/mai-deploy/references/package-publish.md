# npm / pip Package Publishing

**Target:** MAIOSS

## npm

```powershell
cd C:\TEST\MAIOSS

# Version bump
npm version patch  # or minor / major

# GitHub Release
gh release create v1.0.0 --generate-notes

# Publish
npm publish --access public
```

## pip (Python packages)

```powershell
python -m build
twine upload dist/*
```

## Pre-Deploy Checklist

- [ ] README.md updated
- [ ] LICENSE file exists
- [ ] CHANGELOG.md updated
- [ ] CI/CD (GitHub Actions) passes
- [ ] `.npmignore` or `files` field configured
