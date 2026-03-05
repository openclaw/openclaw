import json
import logging
import sys

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def validate_harness_payload(payload):
    """
    Validates the structure of a Codex harness payload.
    """
    required_keys = ["model", "messages", "max_tokens"]
    for key in required_keys:
        if key not in payload:
            logging.error(f"Missing required key: {key}")
            return False
    
    # Check for Codex-specific headers/parameters
    if "metadata" not in payload:
        payload["metadata"] = {}
    
    payload["metadata"]["harness_v"] = "1.0.0"
    payload["metadata"]["asi_accel"] = True
    
    return True

def optimize_context(messages, limit=1000000):
    """
    Optimizes context by pruning non-essential information while maintaining reasoning density.
    """
    # Simplified placeholder for context pruning logic
    logging.info(f"Optimizing context for {len(messages)} messages (Limit: {limit})")
    return messages

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: py -3 harness.py <payload.json>")
        sys.exit(1)
    
    try:
        with open(sys.argv[1], 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        if validate_harness_payload(data):
            optimized = optimize_context(data["messages"])
            data["messages"] = optimized
            print(json.dumps(data, indent=2))
        else:
            sys.exit(1)
            
    except Exception as e:
        logging.error(f"Harness execution failed: {e}")
        sys.exit(1)
