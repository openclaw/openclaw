<script>
  import { createEventDispatcher } from 'svelte';
  
  export let currentModel = 'claude-opus-4-5';
  export let quickActions = [];

  const dispatch = createEventDispatcher();

  let inputText = '';
  let showModelDropdown = false;

  const models = [
    { id: 'claude-opus-4-5', name: 'Claude Opus', provider: 'Anthropic' },
    { id: 'claude-sonnet-4', name: 'Claude Sonnet', provider: 'Anthropic' },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
    { id: 'gemini-pro', name: 'Gemini Pro', provider: 'Google' }
  ];

  function selectModel(modelId) {
    dispatch('modelChange', modelId);
    showModelDropdown = false;
  }

  function handleSubmit() {
    if (inputText.trim()) {
      console.log('Send:', inputText);
      inputText = '';
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  $: currentModelDisplay = models.find(m => m.id === currentModel)?.name || currentModel;
</script>

<div class="chat-area">
  <div class="center-content">
    <!-- Title -->
    <h1 class="title">EasyHub</h1>

    <!-- Chat Input Box -->
    <div class="input-container">
      <div class="input-box">
        <textarea 
          bind:value={inputText}
          on:keydown={handleKeydown}
          placeholder="Ask anything. Type @ for tools and / for commands."
          rows="1"
        ></textarea>

        <div class="input-actions">
          <!-- Model Selector -->
          <div class="model-selector">
            <button 
              class="model-btn"
              on:click={() => showModelDropdown = !showModelDropdown}
            >
              {currentModelDisplay}
              <span class="chevron">▼</span>
            </button>
            
            {#if showModelDropdown}
              <div class="model-dropdown">
                {#each models as model}
                  <button 
                    class="model-option"
                    class:active={currentModel === model.id}
                    on:click={() => selectModel(model.id)}
                  >
                    <span class="model-name">{model.name}</span>
                    <span class="model-provider">{model.provider}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Send -->
          <button 
            class="send-btn" 
            on:click={handleSubmit}
            disabled={!inputText.trim()}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="quick-actions">
      {#each quickActions as action}
        <button class="action-chip">
          {action.label}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px;
  }

  .center-content {
    width: 100%;
    max-width: 680px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 32px;
  }

  .title {
    font-size: 3rem;
    font-weight: 300;
    color: #666;
    margin: 0;
    letter-spacing: -1px;
  }

  .input-container {
    width: 100%;
  }

  .input-box {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    padding: 14px 18px;
    background: #141414;
    border: 1px solid #252525;
    border-radius: 14px;
    transition: border-color 0.2s;
  }

  .input-box:focus-within {
    border-color: #353535;
  }

  textarea {
    flex: 1;
    background: transparent;
    border: none;
    color: #e0e0e0;
    font-size: 1rem;
    font-family: inherit;
    resize: none;
    outline: none;
    line-height: 1.5;
    max-height: 200px;
  }

  textarea::placeholder {
    color: #4a4a4a;
  }

  .input-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .model-selector {
    position: relative;
  }

  .model-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: #1e1e1e;
    border: 1px solid #2a2a2a;
    color: #888;
    font-size: 0.85rem;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.2s;
  }

  .model-btn:hover {
    background: #252525;
    color: #aaa;
  }

  .chevron {
    font-size: 0.55rem;
    opacity: 0.6;
  }

  .model-dropdown {
    position: absolute;
    bottom: 100%;
    right: 0;
    margin-bottom: 8px;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 12px;
    padding: 8px;
    min-width: 180px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    z-index: 100;
  }

  .model-option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    padding: 10px 12px;
    background: transparent;
    border: none;
    color: #ccc;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.15s;
  }

  .model-option:hover {
    background: #262626;
  }

  .model-option.active {
    background: #1e3a5f;
    color: #60a5fa;
  }

  .model-name {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .model-provider {
    font-size: 0.75rem;
    color: #555;
  }

  .model-option.active .model-provider {
    color: #60a5fa88;
  }

  .send-btn {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: #2dd4bf;
    color: #000;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .send-btn:hover:not(:disabled) {
    background: #5eead4;
  }

  .send-btn:disabled {
    background: #252525;
    color: #444;
    cursor: not-allowed;
  }

  .quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: center;
  }

  .action-chip {
    padding: 10px 20px;
    background: transparent;
    border: 1px solid #252525;
    border-radius: 20px;
    color: #666;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .action-chip:hover {
    background: #151515;
    border-color: #353535;
    color: #999;
  }
</style>
