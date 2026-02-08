# How to Submit the Pull Request

**Status:** Code is ready! Just need to push and create PR.

---

## Quick Steps (5-10 minutes)

### Step 1: Fork the OpenClaw Repository

1. Go to: https://github.com/openclaw/openclaw
2. Click the "Fork" button (top right)
3. This creates: `https://github.com/xtromate/openclaw`

### Step 2: Add Your Fork as Remote

```bash
cd C:\Users\faiza\.openclaw\workspace\openclaw-dev

# Add your fork
git remote add myfork https://github.com/xtromate/openclaw.git

# Verify
git remote -v
```

Should show:

```
origin    https://github.com/openclaw/openclaw.git (fetch)
origin    https://github.com/openclaw/openclaw.git (push)
myfork    https://github.com/xtromate/openclaw.git (fetch)
myfork    https://github.com/xtromate/openclaw.git (push)
```

### Step 3: Push Your Branch

```bash
# Push to YOUR fork
git push myfork feature/model-routing
```

**If it asks for credentials:**

- Username: `xtromate`
- Password: Use a GitHub Personal Access Token (not your password!)
  - Get token at: https://github.com/settings/tokens
  - Create new token (classic)
  - Select scopes: `repo` (full control of private repositories)
  - Copy the token and use it as password

### Step 4: Create Pull Request

1. Go to: https://github.com/openclaw/openclaw
2. You should see a yellow banner: "Compare & pull request" - click it
   - OR go to: https://github.com/openclaw/openclaw/compare/main...xtromate:openclaw:feature/model-routing

3. **Fill in the PR form:**

   **Title:**

   ```
   feat: Intelligent model routing for cost optimization
   ```

   **Description:** (Copy from `PR-DESCRIPTION.md`)

   Open `PR-DESCRIPTION.md` and copy the ENTIRE contents into the GitHub PR description box.

4. **Add labels (if available):**
   - `enhancement`
   - `feature`

5. **Link to issue:**
   - The description already contains `Closes #11068`

6. **Click "Create pull request"** ✅

---

## Alternative: GitHub Desktop (Easier)

If you have GitHub Desktop installed:

1. **Open GitHub Desktop**
2. **Add repository:** File → Add Local Repository
3. **Select:** `C:\Users\faiza\.openclaw\workspace\openclaw-dev`
4. **Fork the repository** (GitHub Desktop will prompt)
5. **Push branch:** Click "Push origin" → Select "Fork"
6. **Create PR:** Click "Create Pull Request" button

---

## Alternative: VS Code (If You Use It)

1. **Open folder:** `C:\Users\faiza\.openclaw\workspace\openclaw-dev`
2. **Source Control tab** (Ctrl+Shift+G)
3. **Click "..." menu** → Push To → Create Fork
4. **Push branch**
5. **Click "Create Pull Request"** in notification

---

## Troubleshooting

### "Permission denied" when pushing

**Solution:** You need to fork the repo first (Step 1 above)

### "Authentication failed"

**Solution:** Use a Personal Access Token instead of password

- Go to: https://github.com/settings/tokens
- Generate new token (classic)
- Use token as password when git asks

### "Branch already exists"

**Solution:** That's fine! It means you already pushed it. Just create the PR (Step 4).

### "Remote already exists"

**Solution:** That's okay, skip the `git remote add` command

---

## What Happens After PR Submission?

1. **OpenClaw maintainers get notified**
2. **Automated tests run** (CI/CD)
3. **Review process begins**
   - They'll review code
   - Ask questions
   - Request changes (if needed)
4. **Merge** (when approved)

**Timeline:** Usually 1-7 days for first review

---

## Need Help?

**If you get stuck:**

1. **Share error message** - Tell me what error you see
2. **Try GitHub Desktop** - Easier than command line
3. **Manual upload** - Can also create PR via GitHub web interface

---

## Files Ready for PR

All these files are committed and ready:

✅ Core code (3 files)
✅ Tests (1 file)
✅ Config schema (2 files modified)
✅ Documentation (6 files)

**Total:** 7 commits, ~2,600 lines, 12 hours of work

---

## PR Preview

**Title:** `feat: Intelligent model routing for cost optimization`

**Body:** (from `PR-DESCRIPTION.md`)

- Problem statement
- Solution overview
- Cost savings example (73%)
- Technical implementation
- Test coverage
- Documentation links
- Migration guide
- Review checklist

**Links to:**

- Issue #11068
- Feature documentation
- Quick start guide

---

**You're almost there!** Just need to fork → push → create PR. 🚀

**Time needed:** 5-10 minutes

Let me know if you need help with any step!
