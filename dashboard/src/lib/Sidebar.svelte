<script>
  // Empty sidebar - features will be added here as they're built
</script>

<aside>
  <div class="top">
    <!-- Logo only -->
    <div class="logo">
      <span class="logo-text">E</span>
    </div>
  </div>

  <div class="bottom">
    <!-- Settings -->
    <button class="settings-btn" title="Settings">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    </button>
  </div>
</aside>

<style>
  aside {
    width: 60px;
    background: #0f0f0f;
    border-right: 1px solid #1a1a1a;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 16px 0;
    flex-shrink: 0;
  }

  .top, .bottom {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .logo {
    width: 36px;
    height: 36px;
    background: linear-gradient(135deg, #2dd4bf, #60a5fa);
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .logo-text {
    font-size: 1.2rem;
    font-weight: 700;
    color: #000;
  }

  .settings-btn {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    border: none;
    background: transparent;
    color: #555;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .settings-btn:hover {
    background: #1a1a1a;
    color: #888;
  }
</style>
