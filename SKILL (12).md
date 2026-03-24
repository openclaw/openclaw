---
name: colab-fine-tuning-orchestrator
description: Automate Google Colab fine-tuning via Selenium/Playwright for nightly training. Use when user asks "automatise Colab training", "setup nightly fine-tuning", "orchestrate Colab nocturne", or needs unattended fine-tuning automation without manual intervention. Critical for circadian cycle - enables true autonomous improvement.
---

# COLAB FINE-TUNING ORCHESTRATOR

Fully automated Colab control for nightly fine-tuning without human intervention.

## Architecture

**Local script** → **Selenium/Playwright** → **Colab notebook** → **Training** → **Download checkpoint**

## Complete Automation Script

```python
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time, os, glob

def orchestrate_colab_training(dataset_path, notebook_id):
    """
    Full automation: upload dataset → run training → download checkpoint
    """
    
    driver = setup_driver()
    
    try:
        # 1. Navigate to notebook
        print("1. Opening Colab notebook...")
        driver.get(f'https://colab.research.google.com/drive/{notebook_id}')
        time.sleep(5)
        
        # 2. Connect runtime
        print("2. Connecting to runtime...")
        connect_runtime(driver)
        
        # 3. Upload dataset to Drive
        print("3. Uploading dataset to Drive...")
        upload_to_drive(dataset_path)
        
        # 4. Run cells
        print("4. Running all cells...")
        run_all_cells(driver)
        
        # 5. Monitor training
        print("5. Monitoring training...")
        wait_for_completion(driver)
        
        # 6. Download checkpoint
        print("6. Downloading checkpoint...")
        checkpoint_path = download_checkpoint()
        
        # 7. Load new weights locally
        print("7. Loading new weights...")
        load_checkpoint_locally(checkpoint_path)
        
        print("✓ Training complete - agent upgraded!")
        
    finally:
        driver.quit()
    
    return checkpoint_path

def setup_driver():
    """Setup headless Chrome"""
    options = webdriver.ChromeOptions()
    options.add_argument('--headless')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    
    # Login cookies (setup once manually)
    driver = webdriver.Chrome(options=options)
    driver.add_cookie(load_google_cookies())
    
    return driver

def connect_runtime(driver):
    """Click connect button and wait for GPU"""
    wait = WebDriverWait(driver, 30)
    
    # Find and click connect
    connect_btn = wait.until(
        EC.element_to_be_clickable((By.XPATH, "//button[contains(text(), 'Connect')]"))
    )
    connect_btn.click()
    
    # Wait for GPU allocation
    time.sleep(15)
    
    # Verify GPU connected
    gpu_status = driver.find_element(By.ID, "runtime-info")
    if "T4" not in gpu_status.text:
        raise Exception("GPU not allocated")
    
    print("✓ Runtime connected (T4 GPU)")

def run_all_cells(driver):
    """Execute all notebook cells"""
    
    # Click Runtime → Run all
    runtime_menu = driver.find_element(By.XPATH, "//div[text()='Runtime']")
    runtime_menu.click()
    time.sleep(1)
    
    run_all = driver.find_element(By.XPATH, "//div[text()='Run all']")
    run_all.click()
    
    print("✓ All cells running")

def wait_for_completion(driver):
    """Monitor outputs for completion signal"""
    
    while True:
        time.sleep(60)  # Check every minute
        
        # Get all cell outputs
        outputs = driver.find_elements(By.CLASS_NAME, "output_area")
        
        # Check for "Training complete" or error
        for output in outputs:
            text = output.text
            
            if "Training complete" in text:
                print("✓ Training finished successfully")
                return True
            
            if "Error" in text or "CUDA out of memory" in text:
                raise Exception(f"Training failed: {text}")
        
        # Timeout after 4 hours
        if time.time() - start_time > 14400:
            raise Exception("Training timeout (4h)")

def download_checkpoint():
    """Download trained model from Drive"""
    
    # Use Google Drive API or rclone
    os.system('rclone copy gdrive:/Agent_Circadien/checkpoints/checkpoint_latest.gguf models/')
    
    checkpoint_path = 'models/checkpoint_latest.gguf'
    
    if os.path.exists(checkpoint_path):
        print(f"✓ Checkpoint downloaded: {checkpoint_path}")
        return checkpoint_path
    else:
        raise Exception("Checkpoint download failed")

def load_checkpoint_locally(checkpoint_path):
    """Replace current model with new checkpoint"""
    
    # Backup current
    os.system('cp models/current.gguf models/backup_$(date +%Y%m%d).gguf')
    
    # Replace with new
    os.system(f'cp {checkpoint_path} models/current.gguf')
    
    # Restart llama-server
    os.system('pkill llama-server')
    os.system('llama-server -m models/current.gguf --port 8080 &')
    
    time.sleep(10)  # Wait for server start
    
    print("✓ New weights loaded - agent upgraded!")

# Helper: Keep-alive during training
def keep_alive_thread(driver):
    """Prevent Colab disconnect"""
    while training_active:
        driver.execute_script("console.log('stay alive')")
        time.sleep(300)  # Every 5min
```

## Error Handling

```python
def orchestrate_with_retry(dataset_path, notebook_id, max_retries=3):
    """Retry logic for robustness"""
    
    for attempt in range(max_retries):
        try:
            return orchestrate_colab_training(dataset_path, notebook_id)
        
        except Exception as e:
            print(f"Attempt {attempt+1} failed: {e}")
            
            if attempt < max_retries - 1:
                print("Retrying in 5 minutes...")
                time.sleep(300)
            else:
                # Send alert
                send_alert(f"Colab training failed after {max_retries} attempts: {e}")
                raise
```

---

**FIN SKILL**

Colab automation - enables true autonomous nightly fine-tuning.
