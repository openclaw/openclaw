#!/bin/bash
# Show recently updated docs
DAYS=${1:-7}
echo "Docs updated in the last $DAYS days"
# In full version, this queries the change tracking
