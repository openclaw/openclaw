---
summary: Run OpenClaw in a rootless Podman container
read_when:
  - You want a containerized gateway with Podman instead of Docker
title: Podman
---

# Podman

在 **rootless** Podman 容器中執行 OpenClaw gateway。使用與 Docker 相同的映像檔（從 repo 的 [Dockerfile](https://github.com/openclaw/openclaw/blob/main/Dockerfile) 建置）。

## 需求

- Podman（rootless）
- 一次性設定需使用 sudo（建立使用者、建置映像檔）

## 快速開始

**1. 一次性設定**（從 repo 根目錄執行；建立使用者、建置映像檔、安裝啟動腳本）：

```bash
./setup-podman.sh
```

此步驟也會建立一個最小的 `~openclaw/.openclaw/openclaw.json`（設定 `gateway.mode="local"`），讓 gateway 可以在不執行設定精靈的情況下啟動。

預設情況下，容器 **不會** 安裝為 systemd 服務，需要手動啟動（見下方說明）。若要進行生產環境式的設定，包含自動啟動與重啟，請改安裝為 systemd Quadlet 使用者服務：

```bash
./setup-podman.sh --quadlet
```

（或設定 `OPENCLAW_PODMAN_QUADLET=1`；使用 `--container` 僅安裝容器與啟動腳本。）

建置時可選擇設定的環境變數（於執行 `setup-podman.sh` 前設定）：

- `OPENCLAW_DOCKER_APT_PACKAGES` — 在映像檔建置期間安裝額外的 apt 套件
- `OPENCLAW_EXTENSIONS` — 預先安裝擴充套件依賴（以空白分隔的擴充套件名稱，例如 `diagnostics-otel matrix`）

**2. 啟動 gateway**（手動，快速測試用）：

```bash
./scripts/run-openclaw-podman.sh launch
```

**3. 新手引導精靈**（例如用於新增頻道或提供者）：

```bash
./scripts/run-openclaw-podman.sh launch setup
```

接著打開 `http://127.0.0.1:18789/`，並使用來自 `~openclaw/.openclaw/.env` 的 token（或 setup 顯示的值）。

## Systemd（Quadlet，可選）

如果你執行了 `./setup-podman.sh --quadlet`（或 `OPENCLAW_PODMAN_QUADLET=1`），會安裝一個 [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html）單元，讓 gateway 以 openclaw 使用者的 systemd 使用者服務執行。該服務會在安裝結束時啟用並啟動。

- **啟動：** `sudo systemctl --machine openclaw@ --user start openclaw.service`
- **停止：** `sudo systemctl --machine openclaw@ --user stop openclaw.service`
- **狀態：** `sudo systemctl --machine openclaw@ --user status openclaw.service`
- **日誌：** `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`

quadlet 檔案位於 `~openclaw/.config/containers/systemd/openclaw.container`。若要更改埠號或環境變數，請編輯該檔案（或其所引用的 `.env`），然後 `sudo systemctl --machine openclaw@ --user daemon-reload` 並重新啟動服務。開機時，如果為 openclaw 啟用了 lingering（setup 在 loginctl 可用時會自動設定），服務會自動啟動。

若要在未使用 quadlet 的初始設定後新增 quadlet，請重新執行：`./setup-podman.sh --quadlet`。

## openclaw 使用者（非登入帳號）

`setup-podman.sh` 會建立一個專用系統使用者 `openclaw`：

- **Shell：** `nologin` — 無互動式登入，降低攻擊面。
- **Home 目錄：** 例如 `/home/openclaw` — 存放 `~/.openclaw`（設定檔、工作區）及啟動腳本 `run-openclaw-podman.sh`。
- **Rootless Podman：** 該使用者必須有 **subuid** 和 **subgid** 範圍。許多發行版在建立使用者時會自動分配。如果 setup 顯示警告，請將以下內容加入 `/etc/subuid` 和 `/etc/subgid`：

```text
  openclaw:100000:65536
```

然後以該使用者身份啟動 gateway（例如從 cron 或 systemd）：

```bash
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh setup
```

- **設定檔：** 只有 `openclaw` 和 root 可以存取 `/home/openclaw/.openclaw`。要編輯設定：gateway 執行後可使用控制介面，或使用 `sudo -u openclaw $EDITOR /home/openclaw/.openclaw/openclaw.json`。

## 環境與設定

- **Token：** 儲存在 `~openclaw/.openclaw/.env` 中，名稱為 `OPENCLAW_GATEWAY_TOKEN`。若缺少，`setup-podman.sh` 和 `run-openclaw-podman.sh` 會自動產生（使用 `openssl`、`python3` 或 `od`）。
- **可選設定：** 在該 `.env` 中可以設定提供者金鑰（例如 `GROQ_API_KEY`、`OLLAMA_API_KEY`）及其他 OpenClaw 環境變數。
- **主機埠口：** 預設腳本會映射 `18789`（gateway）和 `18790`（bridge）。啟動時可用 `OPENCLAW_PODMAN_GATEWAY_HOST_PORT` 和 `OPENCLAW_PODMAN_BRIDGE_HOST_PORT` 覆寫 **host** 埠口映射。
- **Gateway 綁定：** 預設 `run-openclaw-podman.sh` 會以 `--bind loopback` 啟動 gateway，確保本地安全存取。若要在區域網路公開，請設定 `OPENCLAW_GATEWAY_BIND=lan` 並在 `openclaw.json` 中設定 `gateway.controlUi.allowedOrigins`（或明確啟用 host-header fallback）。
- **路徑：** 主機設定與工作區預設為 `~openclaw/.openclaw` 和 `~openclaw/.openclaw/workspace`。可用 `OPENCLAW_CONFIG_DIR` 和 `OPENCLAW_WORKSPACE_DIR` 覆寫啟動腳本使用的主機路徑。

## 儲存模型

- **持久化主機資料：** `OPENCLAW_CONFIG_DIR` 和 `OPENCLAW_WORKSPACE_DIR` 會以綁定掛載方式掛入容器，並保留主機上的狀態。
- **臨時沙盒 tmpfs：** 若啟用 `agents.defaults.sandbox`，工具沙盒容器會將 `tmpfs` 掛載到 `/tmp`、`/var/tmp` 和 `/run`。這些路徑為記憶體後端，沙盒容器停止後即消失；頂層 Podman 容器設定不會額外添加 tmpfs 掛載。
- **磁碟成長熱點：** 主要需監控的路徑為 `media/`、`agents/<agentId>/sessions/sessions.json`、transcript JSONL 檔案、`cron/runs/*.jsonl`，以及 `/tmp/openclaw/`（或你設定的 `logging.file`）下的滾動檔案日誌。

`setup-podman.sh` 現在會在私人暫存目錄中準備映像檔 tar，並在設定過程中列印所選的基底目錄。非 root 執行時，僅當該基底目錄安全可用時才接受 `TMPDIR`；否則會依序退回使用 `/var/tmp`，再退回 `/tmp`。儲存的 tar 僅限擁有者存取，並串流到目標使用者的 `podman load`，因此私人呼叫者的暫存目錄不會阻礙設定。

## 常用指令

- **日誌：** 使用 quadlet：`sudo journalctl --machine openclaw@ --user -u openclaw.service -f`。使用腳本：`sudo -u openclaw podman logs -f openclaw`
- **停止：** 使用 quadlet：`sudo systemctl --machine openclaw@ --user stop openclaw.service`。使用腳本：`sudo -u openclaw podman stop openclaw`
- **重新啟動：** 使用 quadlet：`sudo systemctl --machine openclaw@ --user start openclaw.service`。使用腳本：重新執行啟動腳本或 `podman start openclaw`
- **移除容器：** `sudo -u openclaw podman rm -f openclaw` — 主機上的設定與工作區會保留

## 疑難排解

- **設定或 auth-profiles 權限被拒 (EACCES)：** 容器預設為 `--userns=keep-id`，並以執行腳本的主機使用者相同的 uid/gid 執行。請確保主機上的 `OPENCLAW_CONFIG_DIR` 和 `OPENCLAW_WORKSPACE_DIR` 屬於該使用者。
- **Gateway 啟動被阻擋（缺少 `gateway.mode=local`）：** 請確保 `~openclaw/.openclaw/openclaw.json` 存在且設定了 `gateway.mode="local"`。`setup-podman.sh` 會在缺少時建立此檔案。
- **Rootless Podman 對 openclaw 使用者失敗：** 檢查 `/etc/subuid` 和 `/etc/subgid` 是否包含 `openclaw` 的一行（例如 `openclaw:100000:65536`）。若缺少請新增並重新啟動。
- **容器名稱已被使用：** 啟動腳本使用 `podman run --replace`，因此再次啟動時會取代現有容器。若要手動清理：`podman rm -f openclaw`。
- **以 openclaw 執行時找不到腳本：** 請確保已執行 `setup-podman.sh`，使 `run-openclaw-podman.sh` 複製到 openclaw 的家目錄（例如 `/home/openclaw/run-openclaw-podman.sh`）。
- **找不到 quadlet 服務或啟動失敗：** 編輯 `.container` 檔案後執行 `sudo systemctl --machine openclaw@ --user daemon-reload`。quadlet 需要 cgroups v2：`podman info --format '{{.Host.CgroupsVersion}}'` 應顯示 `2`。

## 選用：以你自己的使用者身份執行

若要以一般使用者身份（非專用 openclaw 使用者）執行 gateway：先建置映像檔，建立 `~/.openclaw/.env` 並使用 `OPENCLAW_GATEWAY_TOKEN`，接著以 `--userns=keep-id` 執行容器並掛載你的 `~/.openclaw`。啟動腳本是為 openclaw 使用者流程設計；若為單一使用者設定，可手動執行腳本中的 `podman run` 指令，並將設定與工作區指向你的家目錄。大多數使用者建議使用 `setup-podman.sh`，以 openclaw 使用者身份執行，確保設定與程序隔離。
