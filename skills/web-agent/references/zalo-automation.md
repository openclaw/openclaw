# Zalo 웹 인터페이스 자동화

> 프로젝트: MAISTAR7 — Zalo 메시징/OA 관리 자동화

## 대상 URL

- Zalo Web: `https://chat.zalo.me/`
- Zalo OA Admin: `https://oa.zalo.me/`
- Zalo Business: `https://business.zalo.me/`

## 1. 로그인 플로우

### QR 코드 로그인 (기본)

1. `navigate` → `https://chat.zalo.me/`
2. `snapshot` → QR 코드 이미지 감지
3. **사용자 알림** → "Zalo 앱으로 QR 코드를 스캔해주세요"
4. `act:wait` → QR 코드가 사라지고 채팅 목록이 나타날 때까지 대기
5. 세션 쿠키 유지 (브라우저 프로필 유지)

### 주의

- ⚠️ Zalo는 자동 로그인 불가 — 반드시 사용자 QR 스캔 필요
- 세션 만료 시 재로그인 필요 → 사용자에게 Discord DM 알림
- 크레덴셜 자동 저장/입력 금지

## 2. 메시지 발송 자동화

### 단일 메시지

```
1. snapshot → 채팅 목록에서 대상 찾기
2. act: click → 대화방 선택
3. act: click → 메시지 입력 필드
4. act: type → 메시지 내용 입력
5. act: press → Enter (발송)
```

### 대량 발송 (OA 기반)

```
1. navigate → Zalo OA Admin
2. snapshot → 브로드캐스트/메시지 메뉴
3. 수신 대상 그룹 선택
4. 메시지 템플릿 작성
5. 발송 확인
```

### 제한 사항

- OA 무료: 하루 브로드캐스트 제한 있음
- 개인 메시지: 스팸 탐지 주의 → 메시지 간 5초 이상 간격
- 미디어 첨부: 파일 업로드 시 `browser: upload` 사용

## 3. 연락처 관리

### 연락처 검색

```
1. snapshot → 연락처/친구 탭
2. act: click → 검색 필드
3. act: type → 이름 또는 전화번호
4. snapshot → 결과 확인
```

### 연락처 정보 추출

- 이름, 전화번호 (표시된 경우), 프로필 사진 URL
- 최근 대화 시간

## 4. OA 관리 페이지 조작

### 팔로워 관리

```
1. navigate → https://oa.zalo.me/ → 팔로워 탭
2. snapshot → 팔로워 목록
3. 페이지네이션으로 전체 목록 수집
4. 데이터 추출: 이름, 팔로우 시간, 태그
```

### 자동 응답 설정

```
1. navigate → OA 설정 → 자동 응답
2. snapshot → 기존 규칙 확인
3. 새 규칙 추가/수정
4. 키워드, 응답 메시지, 조건 설정
```

### 게시물 관리

```
1. navigate → OA → 게시물
2. 새 게시물 작성 → 제목, 본문, 이미지 업로드
3. 발행 또는 예약
```

## 보안 주의사항

- ⚠️ Zalo 계정 크레덴셜을 코드/파일에 저장하지 않음
- QR 로그인만 사용 (비밀번호 입력 자동화 금지)
- OA API 토큰이 있으면 브라우저 자동화보다 API 우선 사용
- 대량 작업 시 Zalo 이용약관 준수 여부 확인 필요
- 개인정보(전화번호, 실명) 수집 시 PDPA/개인정보보호법 준수
