# OpenClaw Setup TODO (WSL2 Dev Mode)

## Steps

### 1. Open WSL2 terminal **(Recommended - build failed on Windows bash/Node)**
- Install VSCode Remote-WSL extension.
- Open project in WSL2 distro (Ubuntu etc.).
- Or Windows Terminal `wsl`, `cd /mnt/c/Users/Dmgedgoodz/openclaw`.
- Then `node --version` (install Node if needed), `pnpm install && pnpm build`.

### 2. Install dependencies
```bash
pnpm install
```
[x] Done

### 3. Build project
```bash
pnpm build
```
[ ] Done

### 4. Run onboarding wizard (sets up daemon)
```bash
pnpm openclaw onboard --install-daemon
```
Follow prompts for auth/channels.
[ ] Done

### 5. Start gateway dev server (auto-reload)
```bash
pnpm gateway:watch
```
[ ] Done

### 6. Open dashboard/UI
```bash
pnpm openclaw dashboard
```
Or browser: http://localhost:18789
[ ] Done

### 7. Test & Doctor
```bash
pnpm openclaw doctor
```
[ ] Done

## Alternatives (Recommended now)
### Docker (Windows native, no Node/WSL needed)
1. Install Docker Desktop (if not).
2. `docker compose build` (builds openclaw:local).
3. `docker compose up -d openclaw-gateway`
4. `docker compose exec openclaw-cli openclaw onboard`
5. Dashboard: http://localhost:18789
### Global install
`npm i -g openclaw@latest && openclaw onboard --install-daemon`

## Notes
- Node >=22 required (check `node --version`).
- WSL2 for Linux daemon (systemd).
- Update TODO as steps complete.
