---
title: "Tạo Skills"
---

# Tạo Skills Tùy chỉnh 🛠

OpenClaw được thiết kế để dễ dàng mở rộng. "Skills" là cách chính để thêm các khả năng mới cho trợ lý của bạn.

## Skill là gì?

Một skill là một thư mục chứa tệp `SKILL.md` (cung cấp hướng dẫn và định nghĩa công cụ cho LLM) và có thể kèm theo một số script hoặc tài nguyên.

## Từng bước: Skill đầu tiên của bạn

### 3. 1. 4. Tạo thư mục

Skills nằm trong workspace của bạn, thường là `~/.openclaw/workspace/skills/`. 6. Tạo một thư mục mới cho skill của bạn:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 7. 2. Định nghĩa `SKILL.md`

9. Tạo một tệp `SKILL.md` trong thư mục đó. Tệp này sử dụng frontmatter YAML cho siêu dữ liệu và Markdown cho hướng dẫn.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 11. 3. Thêm Tools (Tùy chọn)

Bạn có thể định nghĩa các công cụ tùy chỉnh trong frontmatter hoặc hướng dẫn tác tử sử dụng các công cụ hệ thống hiện có (như `bash` hoặc `browser`).

### 4. 14. Làm mới OpenClaw

45. Hãy yêu cầu agent của bạn "refresh skills" hoặc khởi động lại gateway. 16. OpenClaw sẽ phát hiện thư mục mới và lập chỉ mục tệp `SKILL.md`.

## Thực hành tốt nhất

- **Ngắn gọn**: Hướng dẫn mô hình về _làm gì_, không phải cách trở thành một AI.
- **An toàn là trên hết**: Nếu skill của bạn sử dụng `bash`, hãy đảm bảo các prompt không cho phép chèn lệnh tùy ý từ dữ liệu người dùng không đáng tin cậy.
- **Kiểm thử cục bộ**: Sử dụng `openclaw agent --message "use my new skill"` để kiểm thử.

## Skills dùng chung

Bạn cũng có thể duyệt và đóng góp skills tại [ClawHub](https://clawhub.com).
