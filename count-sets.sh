#!/bin/bash
echo "User,Month,Count"
for u in ujlW0c5czovW01TWKjvp d8ON3WSQpxEw6C1uh3WM YKj8qNEgsonDpF8WSbJt Mhcs4yWQwXBtpKZRqwI6 tXIFFLPTX782dmGmuJcs; do
  name=$(jq -r --arg u "$u" '.[] | select(.id == $u) | .name' ~/.openclaw/cache/ghl/users.json)
  feb=$(jq -r --arg u "$u" '[.[] | select(.createdBy?.userId == $u and (.dateAdded | startswith("2026-02")))] | length' ~/.openclaw/cache/ghl/calendar-events.json)
  mar=$(jq -r --arg u "$u" '[.[] | select(.createdBy?.userId == $u and (.dateAdded | startswith("2026-03")))] | length' ~/.openclaw/cache/ghl/calendar-events.json)
  apr=$(jq -r --arg u "$u" '[.[] | select(.createdBy?.userId == $u and (.dateAdded | startswith("2026-04")))] | length' ~/.openclaw/cache/ghl/calendar-events.json)
  echo "$name, Feb: $feb, Mar: $mar, Apr: $apr"
done
