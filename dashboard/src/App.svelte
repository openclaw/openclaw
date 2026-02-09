<script>
  import Sidebar from './lib/Sidebar.svelte';
  import ChatArea from './lib/ChatArea.svelte';

  let currentModel = 'claude-opus-4-5';

  let quickActions = [
    { label: 'Search' },
    { label: 'Analyze' },
    { label: 'Summarize' },
    { label: 'Code' },
    { label: 'Browse' }
  ];
</script>

<div class="app">
  <Sidebar />
  
  <main>
    <ChatArea 
      {currentModel}
      {quickActions}
      on:modelChange={(e) => currentModel = e.detail}
    />
  </main>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    background: #0a0a0a;
    color: #e0e0e0;
    overflow: hidden;
  }

  .app {
    display: flex;
    height: 100vh;
    width: 100vw;
  }

  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
