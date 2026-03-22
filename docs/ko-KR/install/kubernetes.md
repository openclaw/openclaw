---
title: "Kubernetes"
summary: "Kustomize 를 사용하여 Kubernetes 클러스터에 OpenClaw Gateway 배포"
read_when:
  - Kubernetes 클러스터에서 OpenClaw 를 실행하고 싶을 때
  - Kubernetes 환경에서 OpenClaw 를 테스트하고 싶을 때
x-i18n:
  source_path: docs/install/kubernetes.md
---

# Kubernetes 에서 OpenClaw

Kubernetes 에서 OpenClaw 를 실행하기 위한 최소한의 시작점입니다 -- 프로덕션용 배포가 아닙니다. 핵심 리소스를 다루며 환경에 맞게 조정하도록 되어 있습니다.

## Helm 이 아닌 이유

OpenClaw 는 몇 가지 설정 파일이 있는 단일 컨테이너입니다. 흥미로운 커스터마이징은 에이전트 콘텐츠 (마크다운 파일, Skills, 설정 재정의) 에 있지 인프라 템플릿이 아닙니다. Kustomize 는 Helm 차트의 오버헤드 없이 오버레이를 처리합니다. 배포가 더 복잡해지면 이러한 매니페스트 위에 Helm 차트를 레이어할 수 있습니다.

## 필요한 것

- 실행 중인 Kubernetes 클러스터 (AKS, EKS, GKE, k3s, kind, OpenShift 등)
- 클러스터에 연결된 `kubectl`
- 최소 하나의 모델 프로바이더용 API 키

## 빠른 시작

```bash
# 프로바이더를 교체: ANTHROPIC, GEMINI, OPENAI 또는 OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh

kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

Gateway 토큰을 가져와 Control UI 에 붙여넣습니다:

```bash
kubectl get secret openclaw-secrets -n openclaw -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

로컬 디버깅의 경우 `./scripts/k8s/deploy.sh --show-token` 이 배포 후 토큰을 출력합니다.

## Kind 로 로컬 테스트

클러스터가 없으면 [Kind](https://kind.sigs.k8s.io/) 로 로컬에 생성하세요:

```bash
./scripts/k8s/create-kind.sh           # docker 또는 podman 자동 감지
./scripts/k8s/create-kind.sh --delete  # 해체
```

그런 다음 `./scripts/k8s/deploy.sh` 로 평소대로 배포합니다.

## 단계별

### 1) 배포

**옵션 A** -- 환경의 API 키 (한 단계):

```bash
# 프로바이더를 교체: ANTHROPIC, GEMINI, OPENAI 또는 OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh
```

스크립트는 API 키와 자동 생성된 Gateway 토큰으로 Kubernetes Secret 을 생성한 다음 배포합니다. Secret 이 이미 존재하면 현재 Gateway 토큰과 변경되지 않는 프로바이더 키를 보존합니다.

**옵션 B** -- 시크릿을 별도로 생성:

```bash
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

로컬 테스트를 위해 토큰을 stdout 에 출력하려면 두 명령 중 하나에 `--show-token` 을 사용하세요.

### 2) Gateway 접근

```bash
kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

## 배포되는 것

```
Namespace: openclaw (OPENCLAW_NAMESPACE 로 구성 가능)
├── Deployment/openclaw        # 단일 파드, init 컨테이너 + Gateway
├── Service/openclaw           # 포트 18789 의 ClusterIP
├── PersistentVolumeClaim      # 에이전트 상태 및 설정을 위한 10Gi
├── ConfigMap/openclaw-config  # openclaw.json + AGENTS.md
└── Secret/openclaw-secrets    # Gateway 토큰 + API 키
```

## 커스터마이징

### 에이전트 지침

`scripts/k8s/manifests/configmap.yaml` 에서 `AGENTS.md` 를 편집하고 재배포합니다:

```bash
./scripts/k8s/deploy.sh
```

### Gateway 설정

`scripts/k8s/manifests/configmap.yaml` 에서 `openclaw.json` 을 편집합니다. 전체 레퍼런스는 [Gateway 구성](/gateway/configuration)을 참고하세요.

### 프로바이더 추가

추가 키를 export 하고 다시 실행:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

기존 프로바이더 키는 덮어쓰지 않는 한 Secret 에 유지됩니다.

또는 Secret 을 직접 패치:

```bash
kubectl patch secret openclaw-secrets -n openclaw \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/openclaw -n openclaw
```

### 커스텀 네임스페이스

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh
```

### 커스텀 이미지

`scripts/k8s/manifests/deployment.yaml` 에서 `image` 필드를 편집합니다:

```yaml
image: ghcr.io/openclaw/openclaw:latest # 또는 https://github.com/openclaw/openclaw/releases 에서 특정 버전 고정
```

### port-forward 너머로 노출

기본 매니페스트는 파드 내부에서 Gateway 를 loopback 에 바인딩합니다. 이것은 `kubectl port-forward` 에서 작동하지만 파드 IP 에 접근해야 하는 Kubernetes `Service` 또는 Ingress 경로에서는 작동하지 않습니다.

Ingress 또는 로드 밸런서를 통해 Gateway 를 노출하려면:

- `scripts/k8s/manifests/configmap.yaml` 에서 Gateway 바인드를 `loopback` 에서 배포 모델에 맞는 non-loopback 바인드로 변경
- Gateway 인증을 활성화하고 적절한 TLS 종료 진입점을 사용
- 지원되는 웹 보안 모델을 사용하여 원격 접근용 Control UI 구성 (예: HTTPS/Tailscale Serve 및 필요시 명시적 허용 오리진)

## 재배포

```bash
./scripts/k8s/deploy.sh
```

모든 매니페스트를 적용하고 설정 또는 시크릿 변경을 반영하기 위해 파드를 재시작합니다.

## 해체

```bash
./scripts/k8s/deploy.sh --delete
```

네임스페이스와 PVC 를 포함한 모든 리소스를 삭제합니다.

## 아키텍처 참고

- Gateway 는 기본적으로 파드 내부의 loopback 에 바인딩되므로 포함된 설정은 `kubectl port-forward` 용
- 클러스터 범위 리소스 없음 -- 모든 것이 단일 네임스페이스에 존재
- 보안: `readOnlyRootFilesystem`, `drop: ALL` 기능, 비루트 사용자 (UID 1000)
- 기본 설정은 Control UI 를 더 안전한 로컬 접근 경로로 유지: loopback 바인드 + `kubectl port-forward` 로 `http://127.0.0.1:18789`
- localhost 접근 너머로 이동하면 지원되는 원격 모델 사용: HTTPS/Tailscale 및 적절한 Gateway 바인드 및 Control UI 오리진 설정
- 시크릿은 임시 디렉토리에서 생성되어 클러스터에 직접 적용 -- 저장소 체크아웃에 시크릿 자료가 작성되지 않음

## 파일 구조

```
scripts/k8s/
├── deploy.sh                   # 네임스페이스 + 시크릿 생성, kustomize 로 배포
├── create-kind.sh              # 로컬 Kind 클러스터 (docker/podman 자동 감지)
└── manifests/
    ├── kustomization.yaml      # Kustomize 베이스
    ├── configmap.yaml          # openclaw.json + AGENTS.md
    ├── deployment.yaml         # 보안 강화가 포함된 파드 사양
    ├── pvc.yaml                # 10Gi 영속 스토리지
    └── service.yaml            # 18789 의 ClusterIP
```
