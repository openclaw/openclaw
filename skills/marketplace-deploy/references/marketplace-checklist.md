# Pre-Publish Checklist

## Universal Checks

- [ ] Version bumped (package.json / setup.py / manifest.json)
- [ ] CHANGELOG updated
- [ ] All tests passing
- [ ] Lint/format clean
- [ ] Build succeeds
- [ ] Working tree clean (committed)
- [ ] README up to date

## npm Specific

- [ ] `npm pack --dry-run` looks correct (no extra files)
- [ ] `.npmignore` or `files` field configured
- [ ] `main`/`module`/`exports` fields correct
- [ ] `peerDependencies` declared if needed
- [ ] License field in package.json

## PyPI Specific

- [ ] `pyproject.toml` or `setup.py` metadata complete
- [ ] `python -m build` produces valid dist/
- [ ] `twine check dist/*` passes
- [ ] Classifiers accurate

## Chrome Web Store Specific

- [ ] Icons: 128x128 PNG
- [ ] Screenshots: 1280x800 or 640x400
- [ ] manifest.json v3 (MV2 deprecated)
- [ ] Privacy policy URL if needed
- [ ] ZIP file under 10MB limit

## VS Code Marketplace Specific

- [ ] `vsce package` succeeds
- [ ] Icon: 256x256 PNG
- [ ] Categories and tags set
- [ ] Engine version compatibility declared
