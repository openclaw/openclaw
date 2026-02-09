<script>
  import Sidebar from './lib/Sidebar.svelte';
  import ChatInterface from './lib/ChatInterface.svelte';

  let theme = 'dark';

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
  }

  $: isDark = theme === 'dark';
</script>

<div class="app" class:dark={isDark} class:light={!isDark}>
  <Sidebar {theme} on:toggleTheme={toggleTheme} />
  
  <main class="content">
    <ChatInterface {theme} />
  </main>

  <!-- Keyboard Shortcut Hint -->
  <div class="shortcut-hint">
    <span><kbd>⌘</kbd> K</span>
    <span class="hint-text">SEARCH ANYWHERE</span>
  </div>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow-x: hidden;
  }

  .app {
    min-height: 100vh;
    width: 100%;
    transition: background-color 0.5s;
  }

  .app.dark {
    background-color: #0a0a0a;
  }

  .app.light {
    background-color: #fafafa;
  }

  .content {
    min-height: 100vh;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 24px;
  }

  .shortcut-hint {
    position: fixed;
    bottom: 24px;
    right: 24px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.05em;
    transition: all 0.5s;
    z-index: 50;
  }

  .dark .shortcut-hint {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #6b7280;
  }

  .light .shortcut-hint {
    background: rgba(0, 0, 0, 0.05);
    border: 1px solid rgba(0, 0, 0, 0.05);
    color: #9ca3af;
  }

  .shortcut-hint kbd {
    font-family: inherit;
  }

  .hint-text {
    opacity: 0.4;
  }
</style>
