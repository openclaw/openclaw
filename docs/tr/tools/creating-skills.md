---
title: "Skills Oluşturma"
---

# Özel Skills Oluşturma 🛠

OpenClaw, kolayca genişletilebilir olacak şekilde tasarlanmıştır. "Skills", asistanınıza yeni yetenekler eklemenin birincil yoludur.

## Skill Nedir?

Bir skill, (LLM’ye talimatlar ve araç tanımları sağlayan) bir `SKILL.md` dosyasını ve isteğe bağlı olarak bazı betikleri veya kaynakları içeren bir dizindir.

## Adım Adım: İlk Skill’iniz

### 1. Dizini Oluşturun

Skills, çalışma alanınızda yer alır; genellikle `~/.openclaw/workspace/skills/`. Skill’iniz için yeni bir klasör oluşturun:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. `SKILL.md` Tanımlayın

Bu dizinde bir `SKILL.md` dosyası oluşturun. Bu dosya, meta veriler için YAML frontmatter ve talimatlar için Markdown kullanır.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Araçlar Ekleyin (İsteğe Bağlı)

Frontmatter içinde özel araçlar tanımlayabilir veya ajana mevcut sistem araçlarını (örneğin `bash` veya `browser`) kullanmasını söyleyebilirsiniz.

### 4. OpenClaw’ı Yenileyin

Ajanınızdan “refresh skills” demesini isteyin ya da gateway’i (ağ geçidi) yeniden başlatın. OpenClaw yeni dizini keşfedecek ve `SKILL.md` dosyasını indeksleyecektir.

## En İyi Uygulamalar

- **Kısa ve Öz Olun**: Modele _ne_ yapacağını söyleyin; nasıl bir AI olacağını değil.
- **Güvenlik Öncelikli**: Skill’iniz `bash` kullanıyorsa, istemlerin güvenilmeyen kullanıcı girdilerinden keyfi komut enjeksiyonuna izin vermediğinden emin olun.
- **Yerelde Test Edin**: Test etmek için `openclaw agent --message "use my new skill"` kullanın.

## Paylaşılan Skills

Ayrıca [ClawHub](https://clawhub.com) üzerinden skills’lere göz atabilir ve katkıda bulunabilirsiniz.
