---
read_when:
    - CLI에서 exec 승인을 편집하고 싶습니다.
    - 게이트웨이 또는 노드 호스트에서 허용 목록을 관리해야 합니다.
summary: '`openclaw approvals`에 대한 CLI 참조(게이트웨이 또는 노드 호스트에 대한 승인 실행)'
title: 승인
x-i18n:
    generated_at: "2026-02-08T15:50:36Z"
    model: gtx
    provider: google-translate
    source_hash: 4329cdaaec2c5f5d619415b6431196512d4834dc1ccd7363576f03dd9b845130
    source_path: cli/approvals.md
    workflow: 15
---

# `openclaw approvals`

다음에 대한 임원 승인을 관리합니다. **로컬 호스트**, **게이트웨이 호스트**, 또는 **노드 호스트**.
기본적으로 명령은 디스크의 로컬 승인 파일을 대상으로 합니다. 사용 `--gateway` 게이트웨이를 타겟팅하거나 `--node` 특정 노드를 타겟팅합니다.

관련된:

- 임원 승인: [임원 승인](/tools/exec-approvals)
- 노드: [노드](/nodes)

## 일반적인 명령

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## 파일에서 승인 바꾸기

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## 허용 목록 도우미

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## 메모

- `--node` 와 동일한 리졸버를 사용합니다. `openclaw nodes` (ID, 이름, IP 또는 ID 접두사).
- `--agent` 기본값은 `"*"`, 이는 모든 상담원에게 적용됩니다.
- 노드 호스트는 광고해야 합니다. `system.execApprovals.get/set` (macOS 앱 또는 헤드리스 노드 호스트)
- 승인 파일은 호스트별로 저장됩니다. `~/.openclaw/exec-approvals.json`.
