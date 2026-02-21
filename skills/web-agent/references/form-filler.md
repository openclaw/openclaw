# 범용 폼 입력 가이드

## 로그인 폼 패턴

```
1. navigate → 로그인 페이지
2. snapshot → email/username, password input 찾기
3. act → { kind: "fill", ref: "<email-input>", text: "user@example.com" }
4. act → { kind: "fill", ref: "<password-input>", text: "password" }
5. act → { kind: "click", ref: "<submit-btn>" }
6. snapshot → 로그인 성공 확인
```

> ⚠️ 비밀번호는 사용자가 직접 제공해야 함. 절대 저장/로깅 금지.

## 검색 폼 패턴

```
1. snapshot → 검색 input 찾기 (placeholder: "Search", "검색" 등)
2. act → { kind: "type", ref: "<search-input>", text: "검색어", submit: true }
   # submit: true = Enter 자동 입력
3. act → { kind: "wait", timeMs: 2000 }
4. snapshot → 결과 확인
```

### 고급 검색 (필터)

```
snapshot → 필터 옵션 찾기
act → { kind: "select", ref: "<category-select>", values: ["electronics"] }
act → { kind: "click", ref: "<price-range>" }
act → { kind: "fill", ref: "<min-price>", text: "100000" }
act → { kind: "fill", ref: "<max-price>", text: "500000" }
act → { kind: "click", ref: "<apply-filter>" }
```

## 회원가입 폼 패턴

```
1. navigate → 회원가입 페이지
2. snapshot → 모든 input 필드 매핑
3. 순서대로 fill:
   - 이름, 이메일, 비밀번호, 비밀번호 확인
   - 전화번호, 주소 등
4. 체크박스 (약관 동의):
   act → { kind: "click", ref: "<terms-checkbox>" }
5. 제출:
   act → { kind: "click", ref: "<register-btn>" }
6. snapshot → 성공/에러 확인
```

### 에러 처리

- 유효성 검사 실패 → snapshot으로 에러 메시지 확인 → 필드 수정
- 이메일 중복 → 사용자에게 알림
- CAPTCHA → 사용자에게 알림

## 파일 업로드 패턴

```
browser upload → paths: ["C:/path/to/file.jpg"]
# 또는
act → { kind: "click", ref: "<upload-btn>" }
# 파일 다이얼로그 → browser upload 사용
```

## 공통 팁

- **fill vs type**: fill은 기존 값을 지우고 입력, type은 추가 입력
- **submit**: type에 `submit: true` 추가하면 Enter 자동
- **탭 이동**: `{ kind: "press", key: "Tab" }` 으로 다음 필드
- **드롭다운**: select 액션 또는 click → 옵션 click
- **날짜 입력**: 캘린더 UI가 있으면 click으로 날짜 선택, 없으면 fill로 직접 입력
- **자동완성 방지**: fill 후 짧은 wait로 자동완성 드롭다운 무시
