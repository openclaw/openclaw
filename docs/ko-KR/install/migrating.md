---
title: "마이그레이션 가이드"
summary: "OpenClaw 설치를 한 머신에서 다른 머신으로 이동 (마이그레이션)"
read_when:
  - OpenClaw 를 새 노트북/서버로 이동할 때
  - 세션, 인증 및 채널 로그인 (WhatsApp 등) 을 보존하고 싶을 때
x-i18n:
  source_path: docs/install/migrating.md
---

# OpenClaw 를 새 머신으로 마이그레이션

이 가이드는 온보딩을 다시 하지 않고 OpenClaw Gateway 를 새 머신으로 이동합니다.

## 마이그레이션되는 것

**상태 디렉토리** (기본 `~/.openclaw/`) 와 **작업 공간**을 복사하면 다음이 보존됩니다:

- **설정** -- `openclaw.json` 및 모든 Gateway 설정
- **인증** -- API 키, OAuth 토큰, 자격 증명 프로필
- **세션** -- 대화 이력 및 에이전트 상태
- **채널 상태** -- WhatsApp 로그인, Telegram 세션 등
- **작업 공간 파일** -- `MEMORY.md`, `USER.md`, Skills 및 프롬프트

<Tip>
이전 머신에서 `openclaw status` 를 실행하여 상태 디렉토리 경로를 확인하세요.
커스텀 프로필은 `~/.openclaw-<profile>/` 또는 `OPENCLAW_STATE_DIR` 로 설정된 경로를 사용합니다.
</Tip>

## 마이그레이션 단계

<Steps>
  <Step title="Gateway 중지 및 백업">
    **이전** 머신에서 파일이 복사 중에 변경되지 않도록 Gateway 를 중지한 다음 아카이브합니다:

    ```bash
    openclaw gateway stop
    cd ~
    tar -czf openclaw-state.tgz .openclaw
    ```

    여러 프로필 (예: `~/.openclaw-work`) 을 사용하는 경우 각각을 별도로 아카이브하세요.

  </Step>

  <Step title="새 머신에 OpenClaw 설치">
    새 머신에 CLI (필요하면 Node 도) 를 [설치](/install)하세요.
    온보딩이 새로운 `~/.openclaw/` 를 생성해도 괜찮습니다 -- 다음 단계에서 덮어씁니다.
  </Step>

  <Step title="상태 디렉토리 및 작업 공간 복사">
    `scp`, `rsync -a` 또는 외부 드라이브를 통해 아카이브를 전송한 다음 추출합니다:

    ```bash
    cd ~
    tar -xzf openclaw-state.tgz
    ```

    숨겨진 디렉토리가 포함되었고 파일 소유권이 Gateway 를 실행할 사용자와 일치하는지 확인하세요.

  </Step>

  <Step title="Doctor 실행 및 확인">
    새 머신에서 [Doctor](/gateway/doctor) 를 실행하여 설정 마이그레이션을 적용하고 서비스를 복구합니다:

    ```bash
    openclaw doctor
    openclaw gateway restart
    openclaw status
    ```

  </Step>
</Steps>

## 일반적인 함정

<AccordionGroup>
  <Accordion title="프로필 또는 state-dir 불일치">
    이전 Gateway 가 `--profile` 또는 `OPENCLAW_STATE_DIR` 을 사용했는데 새 Gateway 가 그렇지 않으면
    채널이 로그아웃된 것으로 표시되고 세션이 비어 있습니다.
    마이그레이션한 것과 **동일한** 프로필 또는 state-dir 로 Gateway 를 실행한 다음 `openclaw doctor` 를 다시 실행하세요.
  </Accordion>

  <Accordion title="openclaw.json 만 복사">
    설정 파일만으로는 충분하지 않습니다. 자격 증명은 `credentials/` 아래에, 에이전트
    상태는 `agents/` 아래에 있습니다. 항상 **전체** 상태 디렉토리를 마이그레이션하세요.
  </Accordion>

  <Accordion title="권한 및 소유권">
    root 로 복사했거나 사용자를 전환한 경우 Gateway 가 자격 증명을 읽지 못할 수 있습니다.
    상태 디렉토리와 작업 공간이 Gateway 를 실행하는 사용자 소유인지 확인하세요.
  </Accordion>

  <Accordion title="원격 모드">
    UI 가 **원격** Gateway 를 가리키는 경우, 원격 호스트가 세션과 작업 공간을 소유합니다.
    로컬 노트북이 아닌 Gateway 호스트 자체를 마이그레이션하세요. [FAQ](/help/faq#where-does-openclaw-store-its-data) 를 참고하세요.
  </Accordion>

  <Accordion title="백업의 시크릿">
    상태 디렉토리에는 API 키, OAuth 토큰 및 채널 자격 증명이 포함되어 있습니다.
    백업을 암호화하여 저장하고, 안전하지 않은 전송 채널을 피하며, 노출이 의심되면 키를 순환하세요.
  </Accordion>
</AccordionGroup>

## 확인 체크리스트

새 머신에서 확인하세요:

- [ ] `openclaw status` 가 Gateway 실행 중으로 표시
- [ ] 채널이 여전히 연결됨 (재페어링 불필요)
- [ ] 대시보드가 열리고 기존 세션이 표시됨
- [ ] 작업 공간 파일 (메모리, 설정) 이 존재함
