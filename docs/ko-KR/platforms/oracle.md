---
summary: "OpenClaw on Oracle Cloud (Always Free ARM)"
read_when:
  - Oracle Cloud 에 OpenClaw 를 설정할 때
  - OpenClaw 용 저비용 VPS 호스팅을 찾을 때
  - 작은 서버에서 24/7 OpenClaw 를 원할 때
title: "Oracle Cloud"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: platforms/oracle.md
  workflow: 15
---

# Oracle Cloud 의 OpenClaw (OCI)

## 목표

Oracle Cloud 의 **Always Free** ARM 계층에서 지속적인 OpenClaw Gateway 를 실행합니다.

Oracle 의 무료 계층은 OpenClaw 에 적합할 수 있습니다 (특히 이미 OCI 계정을 가지고 있다면), 하지만 트레이드오프가 있습니다:

- ARM 아키텍처 (대부분 작동하지만 일부 바이너리는 x86 전용 일 수 있음)
- 용량 및 가입이 까다로울 수 있습니다.

## 비용 비교 (2026)

| 공급자       | 계획            | 사양                  | 가격/개월 | 참고                  |
| ------------ | --------------- | --------------------- | --------- | --------------------- |
| Oracle Cloud | Always Free ARM | 최대 4 OCPU, 24GB RAM | $0        | ARM, 제한된 용량      |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM       | ~ $4      | 가장 저렴한 유료 옵션 |
| DigitalOcean | 기본            | 1 vCPU, 1GB RAM       | $6        | 쉬운 UI, 좋은 문서    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM       | $6        | 많은 위치             |
| Linode       | Nanode          | 1 vCPU, 1GB RAM       | $5        | 현재 Akamai 의 일부   |

---

## 사전 조건

- Oracle Cloud 계정 ([가입](https://www.oracle.com/cloud/free/)) — 문제가 발생하면 [커뮤니티 가입 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) 참조
- Tailscale 계정 ([tailscale.com](https://tailscale.com) 에서 무료)
- ~30 분

## 1) OCI 인스턴스 만들기

1. [Oracle Cloud Console](https://cloud.oracle.com/) 로 로그인합니다.
2. **Compute → Instances → Create Instance** 로 이동
3. 구성:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (또는 최대 4)
   - **Memory:** 12 GB (또는 최대 24 GB)
   - **Boot volume:** 50 GB (무료 최대 200 GB)
   - **SSH key:** 공개 키 추가
4. **Create** 클릭
5. 공개 IP 주소 참고

**팁:** 인스턴스 생성이 "용량 부족" 으로 실패하면 다른 가용성 도메인을 시도하거나 나중에 다시 시도합니다. 무료 계층 용량은 제한되어 있습니다.

## 2) 연결 및 업데이트

```bash
# 공개 IP 를 통해 연결
ssh ubuntu@YOUR_PUBLIC_IP

# 시스템 업데이트
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**참고:** `build-essential` 은 일부 종속성의 ARM 컴파일에 필요합니다.

## 3) 사용자 및 호스트 이름 구성

```bash
# 호스트 이름 설정
sudo hostnamectl set-hostname openclaw

# ubuntu 사용자의 암호 설정
sudo passwd ubuntu

# Lingering 활성화 (로그아웃 후 사용자 서비스 실행 유지)
sudo loginctl enable-linger ubuntu
```

관련 문서: [Gateway 실행 가이드](/ko-KR/gateway), [구성](/ko-KR/gateway/configuration), [Tailscale](/ko-KR/gateway/tailscale).
