class Summarize < Formula
  desc "Link → clean text → summary"
  homepage "https://github.com/steipete/summarize"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/steipete/summarize/releases/download/v0.12.0/summarize-macos-arm64-v0.12.0.tar.gz"
      sha256 "1c053d853d568ef1910570e6c0fa85bc7831faf377f2624b3e9e62284978f4aa"
    end

    on_intel do
      url "https://github.com/steipete/summarize/releases/download/v0.12.0/summarize-macos-x64-v0.12.0.tar.gz"
      sha256 "f6303dfd8fdf9e1bbd867f660eefc2c4b5c37a47af7574b38f73dad7eb1f063f"
    end
  end

  on_linux do
    odie "summarize Homebrew formula is macOS-only; use npm install -g @steipete/summarize on Linux"
  end

  def install
    bin.install "summarize"
  end

  def post_install
    chmod 0755, "#{bin}/summarize"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/summarize --version")
    assert_match "Summarize web pages", shell_output("#{bin}/summarize --help")
  end
end
