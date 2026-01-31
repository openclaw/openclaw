---
name: face-recognition
description: "Learn and recognize faces of family, friends, and pets. Capture, store, and identify people by name using camera."
homepage: https://github.com/openclaw/openclaw
metadata:
  {
    "openclaw":
      {
        "emoji": "👤",
        "requires": { "bins": ["python3"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "package": "face_recognition",
              "bins": ["face_recognition"],
              "label": "Install face_recognition (pip)",
            },
          ],
      },
  }
---

# 👤 Face Recognition

Learn and recognize faces of family members, friends, coworkers, and even pets! The AI remembers faces by name and identifies them in future photos.

## Features

| Feature          | Description                          |
| ---------------- | ------------------------------------ |
| 📷 Learn Face    | Capture and store a face with a name |
| 🔍 Identify      | Recognize who's in a photo           |
| 👨‍👩‍👧‍👦 Family Album  | Manage known faces database          |
| 🐕 Pet Detection | Works with pets too!                 |

---

## Setup

### Install Dependencies

```bash
# macOS
brew install cmake
pip3 install face_recognition opencv-python numpy

# Linux
sudo apt-get install cmake libopenblas-dev liblapack-dev
pip3 install face_recognition opencv-python numpy
```

### Create Faces Directory

```bash
mkdir -p ~/.openclaw/faces
```

---

## 1. 📷 Learn a New Face

Save a person's face with their name:

```bash
# Download/capture a clear photo of the person's face
# Then run this Python script to encode and save it

python3 << 'EOF'
import face_recognition
import pickle
import sys
import os

# Configuration
FACES_DIR = os.path.expanduser("~/.openclaw/faces")
os.makedirs(FACES_DIR, exist_ok=True)

def learn_face(image_path, person_name):
    """Learn a face from an image and save with a name."""
    image = face_recognition.load_image_file(image_path)
    encodings = face_recognition.face_encodings(image)

    if len(encodings) == 0:
        print(f"❌ No face found in {image_path}")
        return False

    if len(encodings) > 1:
        print(f"⚠️ Multiple faces found, using the first one")

    encoding = encodings[0]

    # Load existing database
    db_path = os.path.join(FACES_DIR, "faces.pkl")
    if os.path.exists(db_path):
        with open(db_path, "rb") as f:
            database = pickle.load(f)
    else:
        database = {"names": [], "encodings": []}

    # Add new face
    database["names"].append(person_name)
    database["encodings"].append(encoding)

    # Save database
    with open(db_path, "wb") as f:
        pickle.dump(database, f)

    print(f"✅ Learned {person_name}'s face! Total known: {len(database['names'])}")
    return True

# Usage: learn_face("/path/to/photo.jpg", "John")
EOF
```

### Quick Learn Command

```bash
# Save this as learn_face.py
python3 -c "
import face_recognition, pickle, os, sys
FACES_DIR = os.path.expanduser('~/.openclaw/faces')
os.makedirs(FACES_DIR, exist_ok=True)
image_path, name = sys.argv[1], sys.argv[2]
image = face_recognition.load_image_file(image_path)
encodings = face_recognition.face_encodings(image)
if not encodings: print('No face found'); sys.exit(1)
db_path = os.path.join(FACES_DIR, 'faces.pkl')
db = pickle.load(open(db_path,'rb')) if os.path.exists(db_path) else {'names':[],'encodings':[]}
db['names'].append(name); db['encodings'].append(encodings[0])
pickle.dump(db, open(db_path,'wb'))
print(f'Learned {name}!')
" /path/to/photo.jpg "Person Name"
```

---

## 2. 🔍 Identify Faces in a Photo

Recognize who's in a photo:

```bash
python3 << 'EOF'
import face_recognition
import pickle
import os
import sys

FACES_DIR = os.path.expanduser("~/.openclaw/faces")

def identify_faces(image_path):
    """Identify all faces in an image."""
    db_path = os.path.join(FACES_DIR, "faces.pkl")

    if not os.path.exists(db_path):
        print("❌ No faces learned yet! Use learn_face first.")
        return []

    with open(db_path, "rb") as f:
        database = pickle.load(f)

    known_encodings = database["encodings"]
    known_names = database["names"]

    # Load image to identify
    image = face_recognition.load_image_file(image_path)
    face_locations = face_recognition.face_locations(image)
    face_encodings = face_recognition.face_encodings(image, face_locations)

    results = []
    for encoding in face_encodings:
        matches = face_recognition.compare_faces(known_encodings, encoding, tolerance=0.6)
        distances = face_recognition.face_distance(known_encodings, encoding)

        if True in matches:
            best_match_idx = distances.argmin()
            name = known_names[best_match_idx]
            confidence = (1 - distances[best_match_idx]) * 100
            results.append({"name": name, "confidence": f"{confidence:.1f}%"})
        else:
            results.append({"name": "Unknown", "confidence": "N/A"})

    print(f"Found {len(results)} face(s):")
    for i, r in enumerate(results, 1):
        print(f"  {i}. {r['name']} ({r['confidence']})")

    return results

# Usage: identify_faces("/path/to/photo.jpg")
EOF
```

### Quick Identify Command

```bash
python3 -c "
import face_recognition, pickle, os, sys
FACES_DIR = os.path.expanduser('~/.openclaw/faces')
db_path = os.path.join(FACES_DIR, 'faces.pkl')
if not os.path.exists(db_path): print('No faces learned'); sys.exit(1)
db = pickle.load(open(db_path,'rb'))
image = face_recognition.load_image_file(sys.argv[1])
encodings = face_recognition.face_encodings(image)
for enc in encodings:
    matches = face_recognition.compare_faces(db['encodings'], enc, 0.6)
    dists = face_recognition.face_distance(db['encodings'], enc)
    if True in matches: print(f'Found: {db[\"names\"][dists.argmin()]} ({(1-dists.min())*100:.1f}%)')
    else: print('Unknown face')
" /path/to/photo.jpg
```

---

## 3. 📋 List Known Faces

See who's in your database:

```bash
python3 -c "
import pickle, os
db_path = os.path.expanduser('~/.openclaw/faces/faces.pkl')
if not os.path.exists(db_path): print('No faces learned yet'); exit()
db = pickle.load(open(db_path,'rb'))
print('Known faces:')
for i, name in enumerate(set(db['names']), 1): print(f'  {i}. {name}')
print(f'Total: {len(db[\"names\"])} entries')
"
```

---

## 4. 🗑️ Remove a Face

Remove someone from the database:

```bash
python3 -c "
import pickle, os, sys
name_to_remove = sys.argv[1]
db_path = os.path.expanduser('~/.openclaw/faces/faces.pkl')
db = pickle.load(open(db_path,'rb'))
indices = [i for i, n in enumerate(db['names']) if n == name_to_remove]
for i in reversed(indices):
    db['names'].pop(i); db['encodings'].pop(i)
pickle.dump(db, open(db_path,'wb'))
print(f'Removed {len(indices)} entries for {name_to_remove}')
" "Person Name"
```

---

## 5. 📷 Capture from Camera (macOS)

Use OpenClaw's camera node to capture and identify:

```bash
# Capture photo using OpenClaw camera node
openclaw nodes invoke --node mac --command camera.snap --args '{"path": "/tmp/capture.jpg"}'

# Then identify
python3 identify_faces.py /tmp/capture.jpg
```

---

## 6. 🐕 Pet Recognition

Works with pets too! Just use a clear photo of your pet's face:

```bash
# Learn your pet
python3 learn_face.py /path/to/pet_photo.jpg "Buddy the Dog"

# Identify later
python3 identify_faces.py /path/to/new_photo.jpg
# Output: Found: Buddy the Dog (85.3%)
```

---

## Example Workflow

1. **Setup Family**:

   ```bash
   python3 learn_face.py ~/photos/dad.jpg "Dad"
   python3 learn_face.py ~/photos/mom.jpg "Mom"
   python3 learn_face.py ~/photos/sister.jpg "Sarah"
   python3 learn_face.py ~/photos/dog.jpg "Max"
   ```

2. **Identify in Group Photo**:

   ```bash
   python3 identify_faces.py ~/photos/family_dinner.jpg
   # Output:
   # Found 4 face(s):
   #   1. Dad (92.1%)
   #   2. Mom (88.5%)
   #   3. Sarah (90.3%)
   #   4. Unknown (N/A)  # Maybe a guest!
   ```

3. **Live Camera Identification**:
   ```bash
   # Capture and identify in one command
   openclaw nodes invoke --node mac --command camera.snap --args '{"path": "/tmp/snap.jpg"}' && \
   python3 identify_faces.py /tmp/snap.jpg
   ```

---

## Tips

- 📸 Use **clear, well-lit photos** for better recognition
- 👤 **Multiple photos per person** improves accuracy
- 🔄 **Re-learn** if someone changes hairstyle/appearance significantly
- 💾 **Backup** `~/.openclaw/faces/` to preserve your database
- ⚡ **Tolerance**: Lower = stricter matching, Higher = more lenient (default: 0.6)
